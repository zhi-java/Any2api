/**
 * GLM Express 请求处理器
 *
 * 处理 OpenAI 和 Claude 格式的请求，转换为 GLM API 调用。
 *
 * 重构要点：
 * - 使用共享工具函数（response-utils.js）消除与 DeepSeek 处理器的重复代码
 * - 使用标准响应构建器（openai-response.js, claude-response.js）
 * - 完善流式工具调用输出
 * - 完善 Claude 格式的 tool_use 块支持
 */

import { convertMessages, glmChatCompletion } from './client.js';
import { parseGLMStream } from './stream-parser.js';
import { resolveModel } from './models.js';
import { convertClaudeRequest, streamOpenAIToClaude, writeClaudeSSE } from '../../adapters/claude.js';

import {
  normalizeTools,
  setTCPNoDelay,
  writeSSE,
  flushSSE,
  setupClientDisconnect,
  safeAppendToBuffer,
  parseToolCallsFromText,
  validateToolCallsPipeline,
  createJsonContentExtractor,
} from '../../utils/response-utils.js';

import {
  generateChatCompletionId,
  buildOpenAIResponse,
  buildOpenAIResponseFromContent,
  writeStreamingHeader,
  writeStreamingContent,
  writeStreamingReasoning,
  writeStreamingFinish,
  writeStreamingDone,
  writeStreamingToolCalls,
  sendOpenAIError,
} from '../../utils/openai-response.js';

import {
  generateMessageId,
  buildClaudeResponseFromContent,
  writeClaudeMessageStart,
  writeClaudeTextBlockStart,
  writeClaudeTextDelta,
  writeClaudeThinkingBlockStart,
  writeClaudeThinkingDelta,
  writeClaudeToolUseBlockStart,
  writeClaudeInputJsonDelta,
  writeClaudeContentBlockStop,
  writeClaudeMessageDelta,
  writeClaudeMessageStop,
  writeClaudeStreamEndFromContent,
  openAIToolCallsToClaude,
  sendClaudeError,
} from '../../utils/claude-response.js';

function mayBeJsonToolWrapper(buffer) {
  const trimmed = String(buffer || '').trimStart();
  return trimmed.startsWith('{') || trimmed.startsWith('```') || /^json\s*\{/i.test(trimmed);
}

// ============================================================
// OpenAI 格式处理器 (POST /v1/chat/completions)
// ============================================================

/**
 * POST /v1/chat/completions (OpenAI 格式)
 * GLM 渠道处理器
 */
export async function handleGLMOpenAI(req, res, tokenManager) {
  const { model, messages, stream = true } = req.body;
  const tools = normalizeTools(req.body.tools);
  const toolChoice = req.body.tool_choice ?? 'auto';
  const toolCallingEnabled = tools.length > 0 && toolChoice !== 'none';
  const effectiveToolChoice = toolCallingEnabled ? toolChoice : 'none';

  if (!model || !messages || !messages.length) {
    return sendOpenAIError(res, 400, 'model and messages are required');
  }

  const modelConfig = resolveModel(model);
  const conversationId = req.headers['x-conversation-id'] || '';
  const requestId = generateChatCompletionId();
  const requestStart = Date.now();

  const glmMessages = convertMessages(messages, tools, effectiveToolChoice);

  try {
    const streamBody = await glmChatCompletion(glmMessages, {
      assistantId: modelConfig.assistantId,
      plusModel: modelConfig.plusModel,
      searchEnabled: modelConfig.search,
      chatMode: modelConfig.chatMode || '',
      conversationId,
      tokenManager,
    });

    const { clientGone, cleanup } = setupClientDisconnect(req, streamBody);

    try {
      if (stream) {
        await handleGLMStreamingOpenAI(req, res, streamBody, {
          requestId, model, toolCallingEnabled, tools, toolChoice: effectiveToolChoice, requestStart, clientGone,
        });
      } else {
        await handleGLMNonStreamingOpenAI(res, streamBody, {
          requestId, model, toolCallingEnabled, tools, toolChoice: effectiveToolChoice, requestStart, clientGone,
        });
      }
    } finally {
      cleanup();
    }
  } catch (err) {
    console.error('[GLM] Completion error:', err.message);
    if (!res.headersSent) {
      sendOpenAIError(res, 500, err.message, 'api_error');
    } else {
      if (!res.writableEnded) res.end();
    }
  }
}

/**
 * GLM 流式 OpenAI 响应处理
 *
 * 内容缓冲策略：
 * - 普通文本实时流式输出
 * - 工具 JSON 包装使用增量提取器实时输出 assistant_response，并在 done 时输出 tool_calls
 * - 疑似 JSON 包装先缓冲解析，避免 assistant_response/tool_calls 泄漏
 */
async function handleGLMStreamingOpenAI(req, res, streamBody, { requestId, model, toolCallingEnabled, tools, toolChoice, requestStart, clientGone }) {
  setTCPNoDelay(req);
  writeStreamingHeader(res, requestId, model);

  let contentBuffer = '';
  let toolCallsEmitted = false;
  const jsonExtractor = createJsonContentExtractor();
  let contentFlushBuffer = '';
  let streamedStructuredContent = false;
  let plainStreamingStarted = false;
  const CONTENT_FLUSH_THRESHOLD = 20;

  for await (const event of parseGLMStream(streamBody)) {
    if (clientGone) break;

    switch (event.type) {
      case 'content': {
        const { buffer } = safeAppendToBuffer(contentBuffer, event.content);
        contentBuffer = buffer;

        if (toolCallingEnabled) {
          // JSON 工具包装：增量提取 assistant_response，保留原始缓冲用于 done 时解析 tool_calls。
          const delta = jsonExtractor.process(event.content);
          if (delta) {
            contentFlushBuffer += delta;
            streamedStructuredContent = true;
            if (contentFlushBuffer.length >= CONTENT_FLUSH_THRESHOLD || jsonExtractor.isDone()) {
              writeStreamingContent(res, requestId, model, contentFlushBuffer);
              contentFlushBuffer = '';
              flushSSE(res);
            }
          }
        } else if (!mayBeJsonToolWrapper(contentBuffer)) {
          // 普通无工具文本保持真正 SSE 打字机输出；疑似 JSON 包装则等 done 后清洗。
          plainStreamingStarted = true;
          writeStreamingContent(res, requestId, model, event.content);
          flushSSE(res);
        }
        break;
      }

      case 'thinking':
        writeStreamingReasoning(res, requestId, model, event.content);
        flushSSE(res);
        break;

      case 'tool_calls':
        if (Array.isArray(event.toolCalls)) {
          toolCallsEmitted = true;
          const ARGS_CHUNK_SIZE = 24;
          for (let i = 0; i < event.toolCalls.length; i++) {
            const call = event.toolCalls[i];
            writeSSE(res, {
              id: requestId, object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model,
              choices: [{ index: 0, delta: { tool_calls: [{ index: i, id: call.id, type: 'function', function: { name: call.function.name, arguments: '' } }] }, finish_reason: null }],
            });
            const args = call.function.arguments || '';
            for (let j = 0; j < args.length; j += ARGS_CHUNK_SIZE) {
              writeSSE(res, {
                id: requestId, object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model,
                choices: [{ index: 0, delta: { tool_calls: [{ index: i, function: { arguments: args.slice(j, j + ARGS_CHUNK_SIZE) } }] }, finish_reason: null }],
              });
            }
          }
          writeStreamingFinish(res, requestId, model, 'tool_calls');
        }
        break;

      case 'done': {
        if (contentFlushBuffer) {
          writeStreamingContent(res, requestId, model, contentFlushBuffer);
          contentFlushBuffer = '';
        }

        if (contentBuffer && (toolCallingEnabled || !plainStreamingStarted)) {
          // 从缓冲中解析并剥离 JSON 工具调用包装；已流式输出的 assistant_response 不重复发送。
          const wroteParsed = writeStreamingToolCalls(res, requestId, model, contentBuffer, !streamedStructuredContent, tools, toolChoice);
          if (!wroteParsed) {
            writeStreamingContent(res, requestId, model, contentBuffer);
            writeStreamingFinish(res, requestId, model, 'stop');
          }
        } else if (!toolCallsEmitted) {
          writeStreamingFinish(res, requestId, model, 'stop');
        }
        writeStreamingDone(res);
        flushSSE(res);
        res.end();
        return;
      }

      case 'error':
        throw new Error(event.message);

      case 'image':
        writeStreamingContent(res, requestId, model, `![Generated Image](${event.imageUrl})`);
        break;
    }
  }

  if (!res.writableEnded) {
    writeStreamingDone(res);
    flushSSE(res);
    res.end();
  }
}

/**
 * GLM 非流式 OpenAI 响应处理
 */
async function handleGLMNonStreamingOpenAI(res, streamBody, { requestId, model, toolCallingEnabled, tools, toolChoice, requestStart, clientGone }) {
  let fullContent = '';
  let fullThinking = '';
  let usage = 0;

  for await (const event of parseGLMStream(streamBody)) {
    if (clientGone) break;

    switch (event.type) {
      case 'content':
        fullContent += event.content;
        break;
      case 'thinking':
        fullThinking += event.content;
        break;
      case 'usage':
        if (typeof event.usage === 'number') usage = event.usage;
        break;
      case 'tool_calls':
        fullContent += JSON.stringify(event.toolCalls);
        break;
      case 'error':
        throw new Error(event.message);
    }
  }

  const mergeThinking = process.env.MERGE_THINKING === 'true';
  const response = buildOpenAIResponseFromContent({
    id: requestId,
    model,
    fullContent,
    fullThinking,
    toolCallingEnabled,
    usage: usage || Math.round((fullContent.length + fullThinking.length) / 4),
    mergeThinking,
    definedTools: tools,
    toolChoice,
  });

  res.json(response);
}

// ============================================================
// Claude 格式处理器 (POST /v1/messages)
// ============================================================

/**
 * POST /v1/messages (Claude 格式)
 * GLM 渠道处理器
 */
export async function handleGLMClaude(req, res, tokenManager) {
  try {
    const claudeReq = req.body;
    const model = claudeReq.model;
    const stream = claudeReq.stream ?? true;

    // 1. 转换请求格式
    const openaiReq = convertClaudeRequest(claudeReq);
    const tools = normalizeTools(openaiReq.tools);
    const toolCallingEnabled = tools.length > 0;
    const toolChoice = openaiReq.tool_choice ?? 'auto';
    const effectiveToolChoice = toolCallingEnabled ? toolChoice : 'none';

    // 2. 构建 GLM 消息
    const glmMessages = convertMessages(openaiReq.messages, tools, effectiveToolChoice);
    const modelConfig = resolveModel(model);
    const requestId = generateMessageId();

    // 3. 调用 GLM API
    const streamBody = await glmChatCompletion(glmMessages, {
      assistantId: modelConfig.assistantId,
      plusModel: modelConfig.plusModel,
      searchEnabled: modelConfig.search,
      chatMode: modelConfig.chatMode || '',
      conversationId: '',
      tokenManager,
    });

    // 4. 根据类型处理响应
    if (stream) {
      await handleGLMStreamingClaude(res, streamBody, { requestId, model, toolCallingEnabled, tools, toolChoice: effectiveToolChoice });
    } else {
      await handleGLMNonStreamingClaude(res, streamBody, { requestId, model, toolCallingEnabled, tools, toolChoice: effectiveToolChoice });
    }

  } catch (err) {
    console.error('[GLM Claude] Error:', err.message);
    if (!res.headersSent) {
      sendClaudeError(res, 500, err.message, 'api_error');
    }
  }
}

/**
 * GLM 流式 Claude 响应处理
 * 普通文本实时输出；疑似工具 JSON 包装增量提取 assistant_response 并在结束时输出 tool_use。
 */
async function handleGLMStreamingClaude(res, streamBody, { requestId, model, toolCallingEnabled, tools, toolChoice }) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
  });

  // message_start
  writeClaudeMessageStart(res, requestId, model);

  let contentBuffer = '';
  let blockIndex = 0;
  let thinkingBlockOpen = false;
  let textBlockOpen = false;
  const jsonExtractor = createJsonContentExtractor();
  let contentFlushBuffer = '';
  let streamedStructuredContent = false;
  let plainStreamingStarted = false;
  const CONTENT_FLUSH_THRESHOLD = 20;

  for await (const event of parseGLMStream(streamBody)) {
    if (res.writableEnded) break;

    switch (event.type) {
      case 'content': {
        contentBuffer += event.content;

        if (toolCallingEnabled) {
          const delta = jsonExtractor.process(event.content);
          if (delta) {
            contentFlushBuffer += delta;
            streamedStructuredContent = true;
            if (contentFlushBuffer.length >= CONTENT_FLUSH_THRESHOLD || jsonExtractor.isDone()) {
              if (thinkingBlockOpen) {
                writeClaudeContentBlockStop(res, blockIndex);
                blockIndex++;
                thinkingBlockOpen = false;
              }
              if (!textBlockOpen) {
                writeClaudeTextBlockStart(res, blockIndex);
                textBlockOpen = true;
              }
              writeClaudeTextDelta(res, blockIndex, contentFlushBuffer);
              contentFlushBuffer = '';
              flushSSE(res);
            }
          }
        } else if (!mayBeJsonToolWrapper(contentBuffer)) {
          plainStreamingStarted = true;
          if (thinkingBlockOpen) {
            writeClaudeContentBlockStop(res, blockIndex);
            blockIndex++;
            thinkingBlockOpen = false;
          }
          if (!textBlockOpen) {
            writeClaudeTextBlockStart(res, blockIndex);
            textBlockOpen = true;
          }
          writeClaudeTextDelta(res, blockIndex, event.content);
          flushSSE(res);
        }
        break;
      }
      case 'thinking':
        if (event.content) {
          if (textBlockOpen) {
            writeClaudeContentBlockStop(res, blockIndex);
            blockIndex++;
            textBlockOpen = false;
          }
          if (!thinkingBlockOpen) {
            writeClaudeThinkingBlockStart(res, blockIndex);
            thinkingBlockOpen = true;
          }
          writeClaudeThinkingDelta(res, blockIndex, event.content);
          flushSSE(res);
        }
        break;
      case 'error':
        if (thinkingBlockOpen || textBlockOpen) writeClaudeContentBlockStop(res, blockIndex);
        writeClaudeMessageDelta(res, 'end_turn', 0);
        writeClaudeMessageStop(res);
        res.end();
        return;
    }
  }

  if (contentFlushBuffer) {
    if (thinkingBlockOpen) {
      writeClaudeContentBlockStop(res, blockIndex);
      blockIndex++;
      thinkingBlockOpen = false;
    }
    if (!textBlockOpen) {
      writeClaudeTextBlockStart(res, blockIndex);
      textBlockOpen = true;
    }
    writeClaudeTextDelta(res, blockIndex, contentFlushBuffer);
    contentFlushBuffer = '';
  }

  const shouldParseBufferedContent = contentBuffer && (toolCallingEnabled || !plainStreamingStarted);
  const parsed = shouldParseBufferedContent ? parseToolCallsFromText(contentBuffer) : null;
  const rawToolCalls = parsed?.toolCalls?.length ? parsed.toolCalls : null;
  const { toolCalls, warning } = validateToolCallsPipeline(rawToolCalls, toolChoice, tools);
  if (warning) console.warn(`[GLM Claude stream] ${warning}`);

  const cleanText = parsed ? (parsed.content || '') : '';
  if (cleanText && !streamedStructuredContent) {
    if (thinkingBlockOpen) {
      writeClaudeContentBlockStop(res, blockIndex);
      blockIndex++;
      thinkingBlockOpen = false;
    }
    if (!textBlockOpen) {
      writeClaudeTextBlockStart(res, blockIndex);
      textBlockOpen = true;
    }
    writeClaudeTextDelta(res, blockIndex, cleanText);
  } else if (contentBuffer && shouldParseBufferedContent && !parsed && !plainStreamingStarted) {
    if (!textBlockOpen) {
      writeClaudeTextBlockStart(res, blockIndex);
      textBlockOpen = true;
    }
    writeClaudeTextDelta(res, blockIndex, contentBuffer);
  }

  if (thinkingBlockOpen || textBlockOpen) {
    writeClaudeContentBlockStop(res, blockIndex);
    blockIndex++;
    thinkingBlockOpen = false;
    textBlockOpen = false;
  }

  if (toolCalls?.length) {
    const toolUses = openAIToolCallsToClaude(toolCalls);
    for (const toolUse of toolUses) {
      writeClaudeToolUseBlockStart(res, blockIndex, toolUse.id, toolUse.name);
      writeClaudeInputJsonDelta(res, blockIndex, JSON.stringify(toolUse.input));
      writeClaudeContentBlockStop(res, blockIndex);
      blockIndex++;
    }
    writeClaudeMessageDelta(res, 'tool_use', Math.round(contentBuffer.length / 4));
  } else {
    writeClaudeMessageDelta(res, 'end_turn', Math.round(contentBuffer.length / 4));
  }

  writeClaudeMessageStop(res);
  flushSSE(res);

  if (!res.writableEnded) res.end();
}

/**
 * GLM 非流式 Claude 响应处理
 */
async function handleGLMNonStreamingClaude(res, streamBody, { requestId, model, toolCallingEnabled, tools, toolChoice }) {
  let fullContent = '';
  let fullThinking = '';

  for await (const event of parseGLMStream(streamBody)) {
    if (event.type === 'content') {
      fullContent += event.content;
    } else if (event.type === 'thinking') {
      fullThinking += event.content;
    } else if (event.type === 'error') {
      throw new Error(event.message);
    }
  }

  const response = buildClaudeResponseFromContent({
    id: requestId,
    model,
    fullContent,
    thinking: fullThinking,
    toolCallingEnabled,
    definedTools: tools,
    toolChoice,
    inputTokens: 0,
    outputTokens: Math.round((fullContent.length + fullThinking.length) / 4),
  });

  res.json(response);
}
