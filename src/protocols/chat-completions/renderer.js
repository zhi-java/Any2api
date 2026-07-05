import { aggregateInternalEvents, collectInternalEvents, INTERNAL_EVENT_TYPES, nowSeconds } from '../../core/internal-events.js';
import { errorToResponseError } from '../../core/errors.js';
import { flushSSE, safeEnd, writeSSE } from '../../utils/response-utils.js';

const SYSTEM_FINGERPRINT = process.env.SYSTEM_FINGERPRINT || 'fp_any2api_v1';

function chatId(id) {
  if (!id) return `chatcmpl-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  return id.startsWith('chatcmpl-') ? id : `chatcmpl-${id.replace(/^resp_?/, '')}`;
}

function mapFinishReason(reason) {
  if (reason === 'tool_calls') return 'tool_calls';
  if (reason === 'length') return 'length';
  if (reason === 'error') return 'stop';
  return 'stop';
}

function usageToOpenAI(usage = {}) {
  const promptTokens = usage.inputTokens || 0;
  const completionTokens = usage.outputTokens || 0;
  return {
    prompt_tokens: promptTokens,
    completion_tokens: completionTokens,
    total_tokens: usage.totalTokens || promptTokens + completionTokens,
    prompt_tokens_details: { cached_tokens: 0 },
    completion_tokens_details: { reasoning_tokens: usage.reasoningTokens || 0 },
  };
}

function toOpenAIToolCalls(toolCalls = []) {
  return toolCalls.map(call => ({
    id: call.id,
    type: 'function',
    function: {
      name: call.name,
      arguments: call.arguments || '{}',
    },
  }));
}

export function writeChatError(res, err) {
  const { status, error } = errorToResponseError(err);
  return res.status(status).json({ error });
}

export async function renderChatCompletions(res, events, { model, stream = true } = {}) {
  if (stream) return renderChatCompletionsStream(res, events, { model });
  return renderChatCompletionsJSON(res, events, { model });
}

export async function renderChatCompletionsJSON(res, events, { model } = {}) {
  const collected = await collectInternalEvents(events);
  const failed = collected.find(event => event.type === INTERNAL_EVENT_TYPES.RUN_FAILED);
  if (failed) return res.status(failed.error?.status || 500).json({ error: failed.error });

  const aggregated = aggregateInternalEvents(collected);
  const toolCalls = toOpenAIToolCalls(aggregated.toolCalls);
  const message = {
    role: 'assistant',
    content: toolCalls.length ? (aggregated.text || null) : aggregated.text,
    refusal: null,
  };
  if (aggregated.reasoning) message.reasoning_content = aggregated.reasoning;
  if (toolCalls.length) message.tool_calls = toolCalls;

  return res.json({
    id: chatId(aggregated.responseId),
    object: 'chat.completion',
    created: aggregated.created || nowSeconds(),
    model: aggregated.model || model,
    system_fingerprint: SYSTEM_FINGERPRINT,
    choices: [{
      index: 0,
      message,
      logprobs: null,
      finish_reason: mapFinishReason(aggregated.finishReason),
    }],
    usage: usageToOpenAI(aggregated.usage),
  });
}

export async function renderChatCompletionsStream(res, events, { model } = {}) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no',
  });

  let id = null;
  let currentModel = model;
  let created = nowSeconds();
  let roleSent = false;
  const toolCallIndexes = new Map();

  const base = () => ({ id, object: 'chat.completion.chunk', created, model: currentModel, system_fingerprint: SYSTEM_FINGERPRINT });
  const ensureStarted = (event = {}) => {
    if (!id) id = chatId(event.responseId);
    currentModel = event.model || currentModel;
    created = event.created || created;
    if (!roleSent) {
      roleSent = true;
      writeSSE(res, { ...base(), choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }] });
    }
  };

  try {
    for await (const event of events) {
      if (res.writableEnded) break;
      switch (event.type) {
        case INTERNAL_EVENT_TYPES.RUN_STARTED:
        case INTERNAL_EVENT_TYPES.MESSAGE_STARTED:
          ensureStarted(event);
          break;
        case INTERNAL_EVENT_TYPES.TEXT_DELTA:
          ensureStarted(event);
          if (event.delta) writeSSE(res, { ...base(), choices: [{ index: 0, delta: { content: event.delta }, finish_reason: null }] });
          break;
        case INTERNAL_EVENT_TYPES.REASONING_DELTA:
          ensureStarted(event);
          if (event.delta) writeSSE(res, { ...base(), choices: [{ index: 0, delta: { reasoning_content: event.delta }, finish_reason: null }] });
          break;
        case INTERNAL_EVENT_TYPES.TOOL_CALL_STARTED: {
          ensureStarted(event);
          const index = event.index ?? toolCallIndexes.size;
          toolCallIndexes.set(event.toolCallId, index);
          writeSSE(res, { ...base(), choices: [{ index: 0, delta: { tool_calls: [{ index, id: event.toolCallId, type: 'function', function: { name: event.name, arguments: '' } }] }, finish_reason: null }] });
          if (event.arguments) writeSSE(res, { ...base(), choices: [{ index: 0, delta: { tool_calls: [{ index, function: { arguments: event.arguments } }] }, finish_reason: null }] });
          break;
        }
        case INTERNAL_EVENT_TYPES.TOOL_CALL_ARGUMENTS_DELTA: {
          ensureStarted(event);
          const index = toolCallIndexes.get(event.toolCallId) ?? event.index ?? 0;
          writeSSE(res, { ...base(), choices: [{ index: 0, delta: { tool_calls: [{ index, function: { arguments: event.delta || '' } }] }, finish_reason: null }] });
          break;
        }
        case INTERNAL_EVENT_TYPES.RUN_FAILED:
          ensureStarted(event);
          writeSSE(res, { ...base(), choices: [{ index: 0, delta: { content: event.error?.message || 'Internal Server Error' }, finish_reason: null }] });
          writeSSE(res, { ...base(), choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] });
          res.write('data: [DONE]\n\n');
          flushSSE(res);
          safeEnd(res);
          return;
        case INTERNAL_EVENT_TYPES.RUN_COMPLETED:
          ensureStarted(event);
          writeSSE(res, { ...base(), choices: [{ index: 0, delta: {}, finish_reason: mapFinishReason(event.finishReason) }] });
          res.write('data: [DONE]\n\n');
          flushSSE(res);
          safeEnd(res);
          return;
      }
    }

    if (!res.writableEnded) {
      ensureStarted({});
      writeSSE(res, { ...base(), choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] });
      res.write('data: [DONE]\n\n');
      flushSSE(res);
      safeEnd(res);
    }
  } catch (err) {
    if (!res.headersSent) return writeChatError(res, err);
    writeSSE(res, { ...base(), choices: [{ index: 0, delta: { content: err.message || 'Internal Server Error' }, finish_reason: null }] });
    writeSSE(res, { ...base(), choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] });
    res.write('data: [DONE]\n\n');
    safeEnd(res);
  }
}
