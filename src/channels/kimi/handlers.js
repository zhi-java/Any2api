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
import { buildKimiMessages, kimiChatCompletion } from './client.js';
import { resolveModel } from './models.js';
import { parseKimiStream } from './stream-parser.js';

function maybeJsonToolWrapper(buffer) {
  const trimmed = String(buffer || '').trimStart();
  return trimmed.startsWith('{') || trimmed.startsWith('```') || /^json\s*\{/i.test(trimmed);
}

function isThinkingEnabled(modelConfig, reqBody) {
  if (modelConfig.thinking) return true;
  return Boolean(reqBody.enable_thinking ?? reqBody.thinking_enabled ?? false);
}

function kimiUpstreamErrorText(message) {
  return String(message || 'Kimi upstream returned an error.');
}

function getKimiErrorStatus(err) {
  const message = err?.message || '';
  if (/No Kimi credentials/i.test(message)) return 503;
  if (/expired/i.test(message)) return 503;
  if (/Kimi completion failed:/i.test(message)) return 503;
  if (/Kimi file upload failed:/i.test(message)) return 503;
  return 500;
}

async function startKimiStream(req, {
  res,
  model,
  messages,
  tools,
  toolChoice,
  tokenManager,
}) {
  const modelConfig = resolveModel(model);
  const prompt = buildKimiMessages(messages, tools, toolChoice);
  const attachments = collectUploadableParts(messages);
  const slot = tokenManager.acquireToken();
  if (!slot) throw new Error(tokenManager.getUnavailableReason());

  const abortController = new AbortController();
  let completed = false;
  let activeStreamBody = null;

  const onClose = () => {
    if (!completed && !res.writableEnded) {
      abortController.abort();
      try { activeStreamBody?.cancel?.(); } catch {}
    }
  };
  res.on('close', onClose);

  try {
    const streamBody = await kimiChatCompletion({
      token: slot.token,
      prompt,
      attachments,
      scenario: modelConfig.scenario,
      thinkingEnabled: isThinkingEnabled(modelConfig, req.body),
      signal: abortController.signal,
      tokenManager,
    });
    activeStreamBody = streamBody;
    return {
      streamBody,
      cleanup() {
        completed = true;
        res.off('close', onClose);
        slot.release();
      },
    };
  } catch (err) {
    completed = true;
    res.off('close', onClose);
    slot.release();
    throw err;
  }
}

export async function handleKimiOpenAI(req, res, tokenManager) {
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
    const { streamBody, cleanup } = await startKimiStream(req, {
      res, model, messages, tools, toolChoice: effectiveToolChoice, tokenManager,
    });

    try {
      if (stream) {
        await handleKimiStreamingOpenAI(req, res, streamBody, {
          requestId, model, toolCallingEnabled, tools, toolChoice: effectiveToolChoice,
        });
      } else {
        await handleKimiNonStreamingOpenAI(res, streamBody, {
          requestId, model, toolCallingEnabled, tools, toolChoice: effectiveToolChoice,
        });
      }
    } finally {
      cleanup();
    }
  } catch (err) {
    if (err.name === 'AbortError') return;
    console.error('[Kimi] Completion error:', err.message);
    if (!res.headersSent) {
      sendOpenAIError(res, getKimiErrorStatus(err), err.message, 'api_error');
    } else {
      safeEnd(res);
    }
  }
}

async function handleKimiStreamingOpenAI(req, res, streamBody, { requestId, model, toolCallingEnabled, tools, toolChoice }) {
  setTCPNoDelay(req);
  writeStreamingHeader(res, requestId, model);

  let contentBuffer = '';
  let contentFlushBuffer = '';
  let streamedStructuredContent = false;
  let plainStreamingStarted = false;
  const jsonExtractor = createJsonContentExtractor();
  const CONTENT_FLUSH_THRESHOLD = 20;

  let upstreamError = '';

  for await (const event of parseKimiStream(streamBody)) {
    if (res.writableEnded) break;

    if (event.type === 'content') {
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
    } else if (event.type === 'thinking') {
      writeStreamingReasoning(res, requestId, model, event.content);
      flushSSE(res);
    } else if (event.type === 'error') {
      upstreamError = kimiUpstreamErrorText(event.message);
      break;
    } else if (event.type === 'done') {
      break;
    }
  }

  if (upstreamError) {
    writeStreamingContent(res, requestId, model, upstreamError);
    writeStreamingFinish(res, requestId, model, 'stop');
    writeStreamingDone(res);
    flushSSE(res);
    safeEnd(res);
    return;
  }

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
}

async function handleKimiNonStreamingOpenAI(res, streamBody, { requestId, model, toolCallingEnabled, tools, toolChoice }) {
  let fullContent = '';
  let fullThinking = '';

  for await (const event of parseKimiStream(streamBody)) {
    if (event.type === 'content') fullContent += event.content;
    else if (event.type === 'thinking') fullThinking += event.content;
    else if (event.type === 'error') {
      fullContent += kimiUpstreamErrorText(event.message);
      break;
    }
  }

  res.json(buildOpenAIResponseFromContent({
    id: requestId,
    model,
    fullContent,
    fullThinking,
    toolCallingEnabled,
    usage: Math.round((fullContent.length + fullThinking.length) / 4),
    definedTools: tools,
    toolChoice,
  }));
}

export async function handleKimiClaude(req, res, tokenManager) {
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

    const { streamBody, cleanup } = await startKimiStream(req, {
      res,
      model,
      messages: openaiReq.messages,
      tools,
      toolChoice: effectiveToolChoice,
      tokenManager,
    });

    try {
      if (stream) {
        await handleKimiStreamingClaude(res, streamBody, { requestId, model, toolCallingEnabled, tools, toolChoice: effectiveToolChoice });
      } else {
        await handleKimiNonStreamingClaude(res, streamBody, { requestId, model, toolCallingEnabled, tools, toolChoice: effectiveToolChoice });
      }
    } finally {
      cleanup();
    }
  } catch (err) {
    if (err.name === 'AbortError') return;
    console.error('[Kimi Claude] Error:', err.message);
    if (!res.headersSent) {
      sendClaudeError(res, getKimiErrorStatus(err), err.message, 'api_error');
    } else {
      safeEnd(res);
    }
  }
}

async function handleKimiStreamingClaude(res, streamBody, { requestId, model, toolCallingEnabled, tools, toolChoice }) {
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

  let upstreamError = '';

  for await (const event of parseKimiStream(streamBody)) {
    if (res.writableEnded) break;

    if (event.type === 'content') {
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
    } else if (event.type === 'error') {
      upstreamError = kimiUpstreamErrorText(event.message);
      break;
    } else if (event.type === 'done') {
      break;
    }
  }

  if (upstreamError) {
    writeText(upstreamError);
    closeOpenBlock();
    writeClaudeMessageDelta(res, 'end_turn', Math.round(upstreamError.length / 4));
    writeClaudeMessageStop(res);
    flushSSE(res);
    safeEnd(res);
    return;
  }

  if (contentFlushBuffer) {
    writeText(contentFlushBuffer);
    contentFlushBuffer = '';
  }

  const shouldParseBufferedContent = contentBuffer && (toolCallingEnabled || !plainStreamingStarted);
  const parsed = shouldParseBufferedContent ? parseToolCallsFromText(contentBuffer) : null;
  const rawToolCalls = parsed?.toolCalls?.length ? parsed.toolCalls : null;
  const { toolCalls, warning } = validateToolCallsPipeline(rawToolCalls, toolChoice, tools);
  if (warning) console.warn(`[Kimi Claude stream] ${warning}`);

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

async function handleKimiNonStreamingClaude(res, streamBody, { requestId, model, toolCallingEnabled, tools, toolChoice }) {
  let fullContent = '';
  let fullThinking = '';

  for await (const event of parseKimiStream(streamBody)) {
    if (event.type === 'content') fullContent += event.content;
    else if (event.type === 'thinking') fullThinking += event.content;
    else if (event.type === 'error') {
      fullContent += kimiUpstreamErrorText(event.message);
      break;
    }
  }

  res.json(buildClaudeResponseFromContent({
    id: requestId,
    model,
    fullContent,
    thinking: fullThinking,
    toolCallingEnabled,
    definedTools: tools,
    toolChoice,
    inputTokens: 0,
    outputTokens: Math.round((fullContent.length + fullThinking.length) / 4),
  }));
}
