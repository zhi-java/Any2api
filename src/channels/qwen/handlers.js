import { convertClaudeRequest } from '../../adapters/claude.js';
import {
  buildOpenAIResponseFromContent,
  generateChatCompletionId,
  sendOpenAIError,
  writeStreamingContent,
  writeStreamingDone,
  writeStreamingFinish,
  writeStreamingHeader,
  writeStreamingReasoning,
  writeStreamingToolCalls,
} from '../../utils/openai-response.js';
import {
  buildClaudeResponseFromContent,
  generateMessageId,
  openAIToolCallsToClaude,
  sendClaudeError,
  writeClaudeContentBlockStop,
  writeClaudeInputJsonDelta,
  writeClaudeMessageDelta,
  writeClaudeMessageStart,
  writeClaudeMessageStop,
  writeClaudeTextBlockStart,
  writeClaudeTextDelta,
  writeClaudeThinkingBlockStart,
  writeClaudeThinkingDelta,
  writeClaudeToolUseBlockStart,
} from '../../utils/claude-response.js';
import {
  createJsonContentExtractor,
  flushSSE,
  normalizeTools,
  parseToolCallsFromText,
  safeEnd,
  setTCPNoDelay,
  validateToolCallsPipeline,
} from '../../utils/response-utils.js';
import { collectUploadableParts } from '../../utils/message-files.js';
import { buildQwenMessages, qwenChatCompletion } from './client.js';
import { resolveModel } from './models.js';
import { parseQwenStream } from './stream-parser.js';

function isThinkingEnabled(modelConfig, reqBody) {
  if (modelConfig.forceThinking) return true;
  return Boolean(reqBody.enable_thinking ?? reqBody.thinking_enabled ?? false);
}

function isSearchEnabled(modelConfig, reqBody) {
  if (modelConfig.chatMode === 'deep_research') return true;
  return Boolean(reqBody.enable_search ?? reqBody.search_enabled ?? false);
}

async function startQwenStream(req, {
  model,
  messages,
  tools,
  toolChoice,
  tokenManager,
  queue,
}) {
  const modelConfig = resolveModel(model);
  const qwenMessages = buildQwenMessages(messages, tools, toolChoice);
  const attachments = collectUploadableParts(messages);
  const slot = await queue.enqueueRequest();
  const abortController = new AbortController();
  let completed = false;
  let activeStreamBody = null;

  const onClose = () => {
    if (!completed) {
      abortController.abort();
      try { activeStreamBody?.cancel?.(); } catch {}
    }
  };
  req.on('close', onClose);

  try {
    const streamBody = await qwenChatCompletion({
      token: slot.token,
      model: modelConfig.baseModel,
      messages: qwenMessages,
      attachments,
      chatMode: modelConfig.chatMode,
      thinkingEnabled: isThinkingEnabled(modelConfig, req.body),
      searchEnabled: isSearchEnabled(modelConfig, req.body),
      signal: abortController.signal,
      tokenManager,
    });
    activeStreamBody = streamBody;

    return {
      streamBody,
      cleanup() {
        completed = true;
        req.off('close', onClose);
        slot.release();
        queue.dispatchQueued();
      },
    };
  } catch (err) {
    completed = true;
    req.off('close', onClose);
    slot.release();
    queue.dispatchQueued();
    throw err;
  }
}

function maybeJsonToolWrapper(buffer) {
  const trimmed = String(buffer || '').trimStart();
  return trimmed.startsWith('{') || trimmed.startsWith('```') || /^json\s*\{/i.test(trimmed);
}

function getQwenErrorStatus(err) {
  const message = err?.message || '';
  if (/queued/i.test(message)) return 503;
  if (/waiting for available Qwen token/i.test(message)) return 503;
  if (/No Qwen credentials configured/i.test(message)) return 503;
  if (/All configured Qwen accounts/i.test(message)) return 503;
  if (/Qwen token expired/i.test(message)) return 503;
  if (/^Qwen (create chat|completion) failed:/i.test(message)) return 503;
  return 500;
}

export async function handleQwenOpenAI(req, res, tokenManager, queue) {
  const { model, messages, stream = true } = req.body;
  const tools = normalizeTools(req.body.tools);
  const toolChoice = req.body.tool_choice ?? 'auto';
  const toolCallingEnabled = tools.length > 0 && toolChoice !== 'none';
  const effectiveToolChoice = toolCallingEnabled ? toolChoice : 'none';

  if (!model || !messages || !messages.length) {
    return sendOpenAIError(res, 400, 'model and messages are required');
  }

  const requestId = generateChatCompletionId();

  try {
    const { streamBody, cleanup } = await startQwenStream(req, {
      model, messages, tools, toolChoice: effectiveToolChoice, tokenManager, queue,
    });

    try {
      if (stream) {
        await handleQwenStreamingOpenAI(req, res, streamBody, {
          requestId, model, toolCallingEnabled, tools, toolChoice: effectiveToolChoice,
        });
      } else {
        await handleQwenNonStreamingOpenAI(res, streamBody, {
          requestId, model, toolCallingEnabled, tools, toolChoice: effectiveToolChoice,
        });
      }
    } finally {
      cleanup();
    }
  } catch (err) {
    if (err.name === 'AbortError') return;
    console.error('[Qwen] Completion error:', err.message);
    if (!res.headersSent) {
      const status = getQwenErrorStatus(err);
      sendOpenAIError(res, status, err.message, 'api_error');
    } else {
      safeEnd(res);
    }
  }
}

async function handleQwenStreamingOpenAI(req, res, streamBody, { requestId, model, toolCallingEnabled, tools, toolChoice }) {
  setTCPNoDelay(req);
  writeStreamingHeader(res, requestId, model);

  let contentBuffer = '';
  let contentFlushBuffer = '';
  let streamedStructuredContent = false;
  let plainStreamingStarted = false;
  const jsonExtractor = createJsonContentExtractor();
  const CONTENT_FLUSH_THRESHOLD = 20;

  for await (const event of parseQwenStream(streamBody)) {
    if (res.writableEnded) break;

    switch (event.type) {
      case 'content':
      case 'image': {
        const content = event.content || '';
        contentBuffer += content;

        if (toolCallingEnabled) {
          const delta = jsonExtractor.process(content);
          if (delta) {
            contentFlushBuffer += delta;
            streamedStructuredContent = true;
            if (contentFlushBuffer.length >= CONTENT_FLUSH_THRESHOLD || jsonExtractor.isDone()) {
              writeStreamingContent(res, requestId, model, contentFlushBuffer);
              contentFlushBuffer = '';
            }
          }
        } else if (!maybeJsonToolWrapper(contentBuffer)) {
          plainStreamingStarted = true;
          writeStreamingContent(res, requestId, model, content);
        }
        flushSSE(res);
        break;
      }
      case 'thinking':
        writeStreamingReasoning(res, requestId, model, event.content);
        flushSSE(res);
        break;
      case 'research':
        writeStreamingReasoning(res, requestId, model, `[${event.stage}] ${event.content}`);
        flushSSE(res);
        break;
      case 'done': {
        if (contentFlushBuffer) {
          writeStreamingContent(res, requestId, model, contentFlushBuffer);
          contentFlushBuffer = '';
        }

        if (contentBuffer && (toolCallingEnabled || !plainStreamingStarted)) {
          const wroteParsed = writeStreamingToolCalls(res, requestId, model, contentBuffer, !streamedStructuredContent, tools, toolChoice);
          if (!wroteParsed) {
            writeStreamingContent(res, requestId, model, contentBuffer);
            writeStreamingFinish(res, requestId, model, 'stop');
          }
        } else {
          writeStreamingFinish(res, requestId, model, 'stop');
        }
        writeStreamingDone(res);
        flushSSE(res);
        safeEnd(res);
        return;
      }
    }
  }

  if (!res.writableEnded) {
    writeStreamingDone(res);
    flushSSE(res);
    safeEnd(res);
  }
}

async function handleQwenNonStreamingOpenAI(res, streamBody, { requestId, model, toolCallingEnabled, tools, toolChoice }) {
  let fullContent = '';
  let fullThinking = '';
  let usage = null;

  for await (const event of parseQwenStream(streamBody)) {
    if (res.writableEnded) break;
    if (event.type === 'content' || event.type === 'image') {
      fullContent += event.content;
    } else if (event.type === 'thinking') {
      fullThinking += event.content;
    } else if (event.type === 'research') {
      fullThinking += `[${event.stage}] ${event.content}`;
    } else if (event.type === 'done') {
      usage = event.usage || usage;
    }
  }

  const response = buildOpenAIResponseFromContent({
    id: requestId,
    model,
    fullContent,
    fullThinking,
    toolCallingEnabled,
    usage: usage?.output_tokens || Math.round((fullContent.length + fullThinking.length) / 4),
    definedTools: tools,
    toolChoice,
  });

  response.usage.prompt_tokens = usage?.input_tokens || 0;
  response.usage.total_tokens = response.usage.prompt_tokens + response.usage.completion_tokens;
  res.json(response);
}

export async function handleQwenClaude(req, res, tokenManager, queue) {
  try {
    const claudeReq = req.body;
    const model = claudeReq.model;
    const stream = claudeReq.stream ?? true;

    const openaiReq = convertClaudeRequest(claudeReq);
    const tools = normalizeTools(openaiReq.tools);
    const toolCallingEnabled = tools.length > 0;
    const toolChoice = openaiReq.tool_choice ?? 'auto';
    const effectiveToolChoice = toolCallingEnabled ? toolChoice : 'none';
    const requestId = generateMessageId();

    const { streamBody, cleanup } = await startQwenStream(req, {
      model,
      messages: openaiReq.messages,
      tools,
      toolChoice: effectiveToolChoice,
      tokenManager,
      queue,
    });

    try {
      if (stream) {
        await handleQwenStreamingClaude(res, streamBody, { requestId, model, toolCallingEnabled, tools, toolChoice: effectiveToolChoice });
      } else {
        await handleQwenNonStreamingClaude(res, streamBody, { requestId, model, toolCallingEnabled, tools, toolChoice: effectiveToolChoice });
      }
    } finally {
      cleanup();
    }
  } catch (err) {
    if (err.name === 'AbortError') return;
    console.error('[Qwen Claude] Error:', err.message);
    if (!res.headersSent) {
      const status = getQwenErrorStatus(err);
      sendClaudeError(res, status, err.message, 'api_error');
    } else {
      safeEnd(res);
    }
  }
}

async function handleQwenStreamingClaude(res, streamBody, { requestId, model, toolCallingEnabled, tools, toolChoice }) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });

  writeClaudeMessageStart(res, requestId, model);

  let contentBuffer = '';
  let blockIndex = 0;
  let thinkingBlockOpen = false;
  let textBlockOpen = false;
  let plainStreamingStarted = false;
  let streamedStructuredContent = false;
  let contentFlushBuffer = '';
  const jsonExtractor = createJsonContentExtractor();
  const CONTENT_FLUSH_THRESHOLD = 20;

  const closeOpenBlock = () => {
    if (thinkingBlockOpen || textBlockOpen) {
      writeClaudeContentBlockStop(res, blockIndex);
      blockIndex++;
      thinkingBlockOpen = false;
      textBlockOpen = false;
    }
  };

  const writeText = (text) => {
    if (!text) return;
    if (thinkingBlockOpen) closeOpenBlock();
    if (!textBlockOpen) {
      writeClaudeTextBlockStart(res, blockIndex);
      textBlockOpen = true;
    }
    writeClaudeTextDelta(res, blockIndex, text);
  };

  const writeThinking = (text) => {
    if (!text) return;
    if (textBlockOpen) closeOpenBlock();
    if (!thinkingBlockOpen) {
      writeClaudeThinkingBlockStart(res, blockIndex);
      thinkingBlockOpen = true;
    }
    writeClaudeThinkingDelta(res, blockIndex, text);
  };

  for await (const event of parseQwenStream(streamBody)) {
    if (res.writableEnded) break;

    if (event.type === 'content' || event.type === 'image') {
      const content = event.content || '';
      contentBuffer += content;

      if (toolCallingEnabled) {
        const delta = jsonExtractor.process(content);
        if (delta) {
          contentFlushBuffer += delta;
          streamedStructuredContent = true;
          if (contentFlushBuffer.length >= CONTENT_FLUSH_THRESHOLD || jsonExtractor.isDone()) {
            writeText(contentFlushBuffer);
            contentFlushBuffer = '';
            flushSSE(res);
          }
        }
      } else if (!maybeJsonToolWrapper(contentBuffer)) {
        plainStreamingStarted = true;
        writeText(content);
        flushSSE(res);
      }
    } else if (event.type === 'thinking') {
      writeThinking(event.content);
      flushSSE(res);
    } else if (event.type === 'research') {
      writeThinking(`[${event.stage}] ${event.content}`);
      flushSSE(res);
    } else if (event.type === 'done') {
      break;
    }
  }

  if (contentFlushBuffer) {
    writeText(contentFlushBuffer);
    contentFlushBuffer = '';
  }

  const shouldParseBufferedContent = contentBuffer && (toolCallingEnabled || !plainStreamingStarted);
  const parsed = shouldParseBufferedContent ? parseToolCallsFromText(contentBuffer) : null;
  const rawToolCalls = parsed?.toolCalls?.length ? parsed.toolCalls : null;
  const { toolCalls, warning } = validateToolCallsPipeline(rawToolCalls, toolChoice, tools);
  if (warning) console.warn(`[Qwen Claude stream] ${warning}`);

  const cleanText = parsed ? (parsed.content || '') : '';
  if (cleanText && !streamedStructuredContent) {
    writeText(cleanText);
  } else if (contentBuffer && shouldParseBufferedContent && !parsed && !plainStreamingStarted) {
    writeText(contentBuffer);
  }

  closeOpenBlock();

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
  safeEnd(res);
}

async function handleQwenNonStreamingClaude(res, streamBody, { requestId, model, toolCallingEnabled, tools, toolChoice }) {
  let fullContent = '';
  let fullThinking = '';

  for await (const event of parseQwenStream(streamBody)) {
    if (event.type === 'content' || event.type === 'image') {
      fullContent += event.content;
    } else if (event.type === 'thinking') {
      fullThinking += event.content;
    } else if (event.type === 'research') {
      fullThinking += `[${event.stage}] ${event.content}`;
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
