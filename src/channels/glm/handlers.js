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
  writeClaudeToolUseBlockStart,
  writeClaudeInputJsonDelta,
  writeClaudeContentBlockStop,
  writeClaudeMessageDelta,
  writeClaudeMessageStop,
  writeClaudeStreamEndFromContent,
  openAIToolCallsToClaude,
  sendClaudeError,
} from '../../utils/claude-response.js';

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

  if (!model || !messages || !messages.length) {
    return sendOpenAIError(res, 400, 'model and messages are required');
  }

  const modelConfig = resolveModel(model);
  const conversationId = req.headers['x-conversation-id'] || '';
  const requestId = generateChatCompletionId();
  const requestStart = Date.now();

  const glmMessages = convertMessages(messages, tools);

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
          requestId, model, toolCallingEnabled, requestStart, clientGone,
        });
      } else {
        await handleGLMNonStreamingOpenAI(res, streamBody, {
          requestId, model, toolCallingEnabled, requestStart, clientGone,
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
 * - 非工具调用请求 → 实时流式输出（打字机效果）
 * - 工具调用请求 → 缓冲到 done，解析工具调用后统一输出
 *   （因为 GLM 把工具调用 JSON 嵌入文本中，需要先解析再分别输出）
 */
async function handleGLMStreamingOpenAI(req, res, streamBody, { requestId, model, toolCallingEnabled, requestStart, clientGone }) {
  setTCPNoDelay(req);
  writeStreamingHeader(res, requestId, model);

  let contentBuffer = '';
  let toolCallsEmitted = false;

  for await (const event of parseGLMStream(streamBody)) {
    if (clientGone) break;

    switch (event.type) {
      case 'content': {
        // 始终缓冲（用于结束时工具调用解析）
        const { buffer } = safeAppendToBuffer(contentBuffer, event.content);
        contentBuffer = buffer;
        // 无工具调用时实时输出
        if (!toolCallingEnabled && event.content) {
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
        if (toolCallingEnabled && contentBuffer) {
          // 有工具调用 → 从缓冲中解析，剥离 JSON 后分别输出
          const wroteToolCalls = writeStreamingToolCalls(res, requestId, model, contentBuffer, true);
          if (!wroteToolCalls) {
            // 无工具调用 → 输出缓冲的全部内容
            writeStreamingContent(res, requestId, model, contentBuffer);
            writeStreamingFinish(res, requestId, model, 'stop');
          }
        } else if (!toolCallingEnabled) {
          // 已实时输出，只需 finish
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
async function handleGLMNonStreamingOpenAI(res, streamBody, { requestId, model, toolCallingEnabled, requestStart, clientGone }) {
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

    // 2. 构建 GLM 消息
    const glmMessages = convertMessages(openaiReq.messages, tools);
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
      await handleGLMStreamingClaude(res, streamBody, { requestId, model, toolCallingEnabled });
    } else {
      await handleGLMNonStreamingClaude(res, streamBody, { requestId, model, toolCallingEnabled });
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
 * 统一使用缓冲 + 结束时解析模式（支持工具调用）
 */
async function handleGLMStreamingClaude(res, streamBody, { requestId, model, toolCallingEnabled }) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
  });

  // message_start
  writeClaudeMessageStart(res, requestId, model);

  // content_block_start (text block)
  writeClaudeTextBlockStart(res, 0);

  let contentBuffer = '';

  for await (const event of parseGLMStream(streamBody)) {
    if (res.writableEnded) break;

    switch (event.type) {
      case 'content': {
        contentBuffer += event.content;
        if (event.content) {
          writeClaudeTextDelta(res, 0, event.content);
          flushSSE(res);
        }
        break;
      }
      case 'thinking':
        // Claude 格式无独立 thinking 字段，静默合并
        break;
      case 'error':
        writeClaudeContentBlockStop(res, 0);
        writeClaudeMessageDelta(res, 'end_turn', 0);
        writeClaudeMessageStop(res);
        res.end();
        return;
    }
  }

  // content_block_stop (text)
  writeClaudeContentBlockStop(res, 0);

  // 从累积内容中解析工具调用（如果有）
  const parsedToolCalls = toolCallingEnabled && contentBuffer
    ? parseToolCallsFromText(contentBuffer)
    : null;

  if (parsedToolCalls?.toolCalls?.length) {
    const toolUses = openAIToolCallsToClaude(parsedToolCalls.toolCalls);
    let blockIndex = 1;
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
async function handleGLMNonStreamingClaude(res, streamBody, { requestId, model, toolCallingEnabled }) {
  let fullContent = '';

  for await (const event of parseGLMStream(streamBody)) {
    if (event.type === 'content') {
      fullContent += event.content;
    } else if (event.type === 'error') {
      throw new Error(event.message);
    }
  }

  const response = buildClaudeResponseFromContent({
    id: requestId,
    model,
    fullContent,
    toolCallingEnabled,
    inputTokens: 0,
    outputTokens: Math.round(fullContent.length / 4),
  });

  res.json(response);
}
