import { createInternalId } from './internal-request.js';

export const INTERNAL_EVENT_TYPES = Object.freeze({
  RUN_STARTED: 'run.started',
  MESSAGE_STARTED: 'message.started',
  TEXT_DELTA: 'content.text.delta',
  TEXT_DONE: 'content.text.done',
  REASONING_DELTA: 'reasoning.delta',
  REASONING_DONE: 'reasoning.done',
  TOOL_CALL_STARTED: 'tool_call.started',
  TOOL_CALL_ARGUMENTS_DELTA: 'tool_call.arguments.delta',
  TOOL_CALL_DONE: 'tool_call.done',
  MESSAGE_DONE: 'message.done',
  USAGE_UPDATED: 'usage.updated',
  RUN_COMPLETED: 'run.completed',
  RUN_FAILED: 'run.failed',
});

export function nowSeconds() {
  return Math.floor(Date.now() / 1000);
}

function baseEvent(type, fields = {}) {
  return {
    type,
    timestamp: Date.now(),
    requestId: fields.requestId,
    responseId: fields.responseId,
    messageId: fields.messageId,
    outputIndex: fields.outputIndex ?? 0,
    contentIndex: fields.contentIndex ?? 0,
    raw: fields.raw ?? null,
  };
}

export function createRunStarted({ requestId, responseId = createInternalId('resp'), model, protocol, created = nowSeconds(), raw = null } = {}) {
  return {
    ...baseEvent(INTERNAL_EVENT_TYPES.RUN_STARTED, { requestId, responseId, raw }),
    responseId,
    model,
    protocol,
    created,
  };
}

export function createMessageStarted({ requestId, responseId, messageId = createInternalId('msg'), role = 'assistant', outputIndex = 0, raw = null } = {}) {
  return {
    ...baseEvent(INTERNAL_EVENT_TYPES.MESSAGE_STARTED, { requestId, responseId, messageId, outputIndex, raw }),
    messageId,
    role,
  };
}

export function createTextDelta({ requestId, responseId, messageId, delta = '', outputIndex = 0, contentIndex = 0, raw = null } = {}) {
  return {
    ...baseEvent(INTERNAL_EVENT_TYPES.TEXT_DELTA, { requestId, responseId, messageId, outputIndex, contentIndex, raw }),
    delta,
  };
}

export function createTextDone({ requestId, responseId, messageId, text = '', outputIndex = 0, contentIndex = 0, raw = null } = {}) {
  return {
    ...baseEvent(INTERNAL_EVENT_TYPES.TEXT_DONE, { requestId, responseId, messageId, outputIndex, contentIndex, raw }),
    text,
  };
}

export function createReasoningDelta({ requestId, responseId, messageId, delta = '', outputIndex = 0, contentIndex = 0, raw = null } = {}) {
  return {
    ...baseEvent(INTERNAL_EVENT_TYPES.REASONING_DELTA, { requestId, responseId, messageId, outputIndex, contentIndex, raw }),
    delta,
  };
}

export function createReasoningDone({ requestId, responseId, messageId, text = '', outputIndex = 0, contentIndex = 0, raw = null } = {}) {
  return {
    ...baseEvent(INTERNAL_EVENT_TYPES.REASONING_DONE, { requestId, responseId, messageId, outputIndex, contentIndex, raw }),
    text,
  };
}

export function createToolCallStarted({ requestId, responseId, messageId, toolCallId = createInternalId('call'), index = 0, name, arguments: args = '', raw = null } = {}) {
  return {
    ...baseEvent(INTERNAL_EVENT_TYPES.TOOL_CALL_STARTED, { requestId, responseId, messageId, outputIndex: index, raw }),
    toolCallId,
    index,
    name,
    arguments: args,
  };
}

export function createToolCallArgumentsDelta({ requestId, responseId, messageId, toolCallId, index = 0, delta = '', raw = null } = {}) {
  return {
    ...baseEvent(INTERNAL_EVENT_TYPES.TOOL_CALL_ARGUMENTS_DELTA, { requestId, responseId, messageId, outputIndex: index, raw }),
    toolCallId,
    index,
    delta,
  };
}

export function createToolCallDone({ requestId, responseId, messageId, toolCallId, index = 0, name, arguments: args = '{}', raw = null } = {}) {
  return {
    ...baseEvent(INTERNAL_EVENT_TYPES.TOOL_CALL_DONE, { requestId, responseId, messageId, outputIndex: index, raw }),
    toolCallId,
    index,
    name,
    arguments: args,
  };
}

export function createMessageDone({ requestId, responseId, messageId, status = 'completed', outputIndex = 0, raw = null } = {}) {
  return {
    ...baseEvent(INTERNAL_EVENT_TYPES.MESSAGE_DONE, { requestId, responseId, messageId, outputIndex, raw }),
    status,
  };
}

export function createUsageUpdated({ requestId, responseId, usage = {}, raw = null } = {}) {
  const inputTokens = usage.inputTokens ?? usage.input_tokens ?? usage.prompt_tokens ?? 0;
  const outputTokens = usage.outputTokens ?? usage.output_tokens ?? usage.completion_tokens ?? (typeof usage === 'number' ? usage : 0);
  const reasoningTokens = usage.reasoningTokens ?? usage.reasoning_tokens ?? usage.completion_tokens_details?.reasoning_tokens ?? 0;
  return {
    ...baseEvent(INTERNAL_EVENT_TYPES.USAGE_UPDATED, { requestId, responseId, raw }),
    usage: {
      inputTokens,
      outputTokens,
      reasoningTokens,
      totalTokens: usage.totalTokens ?? usage.total_tokens ?? inputTokens + outputTokens,
    },
  };
}

export function createRunCompleted({ requestId, responseId, finishReason = 'stop', usage = {}, raw = null } = {}) {
  return {
    ...baseEvent(INTERNAL_EVENT_TYPES.RUN_COMPLETED, { requestId, responseId, raw }),
    finishReason,
    usage: createUsageUpdated({ requestId, responseId, usage }).usage,
  };
}

export function createRunFailed({ requestId, responseId, error, raw = null } = {}) {
  return {
    ...baseEvent(INTERNAL_EVENT_TYPES.RUN_FAILED, { requestId, responseId, raw }),
    error: {
      message: error?.message || 'Internal Server Error',
      type: error?.type || 'api_error',
      code: error?.code || null,
      status: error?.status || 500,
      retryable: !!error?.retryable,
    },
  };
}

export async function collectInternalEvents(events) {
  const collected = [];
  for await (const event of events) collected.push(event);
  return collected;
}

export function aggregateInternalEvents(events = []) {
  let responseId = null;
  let messageId = null;
  let model = null;
  let created = nowSeconds();
  let text = '';
  let reasoning = '';
  let finishReason = 'stop';
  let usage = { inputTokens: 0, outputTokens: 0, reasoningTokens: 0, totalTokens: 0 };
  const toolCalls = [];
  const toolCallMap = new Map();

  for (const event of events) {
    if (event.responseId) responseId = event.responseId;
    if (event.messageId) messageId = event.messageId;
    if (event.type === INTERNAL_EVENT_TYPES.RUN_STARTED) {
      model = event.model || model;
      created = event.created || created;
    } else if (event.type === INTERNAL_EVENT_TYPES.TEXT_DELTA) {
      text += event.delta || '';
    } else if (event.type === INTERNAL_EVENT_TYPES.TEXT_DONE) {
      text = event.text ?? text;
    } else if (event.type === INTERNAL_EVENT_TYPES.REASONING_DELTA) {
      reasoning += event.delta || '';
    } else if (event.type === INTERNAL_EVENT_TYPES.REASONING_DONE) {
      reasoning = event.text ?? reasoning;
    } else if (event.type === INTERNAL_EVENT_TYPES.TOOL_CALL_STARTED) {
      const call = {
        id: event.toolCallId,
        index: event.index ?? toolCalls.length,
        name: event.name,
        arguments: event.arguments || '',
      };
      toolCallMap.set(event.toolCallId, call);
      toolCalls.push(call);
    } else if (event.type === INTERNAL_EVENT_TYPES.TOOL_CALL_ARGUMENTS_DELTA) {
      const call = toolCallMap.get(event.toolCallId);
      if (call) call.arguments += event.delta || '';
    } else if (event.type === INTERNAL_EVENT_TYPES.TOOL_CALL_DONE) {
      let call = toolCallMap.get(event.toolCallId);
      if (!call) {
        call = { id: event.toolCallId, index: event.index ?? toolCalls.length, name: event.name, arguments: '' };
        toolCallMap.set(event.toolCallId, call);
        toolCalls.push(call);
      }
      call.name = event.name || call.name;
      call.arguments = event.arguments ?? call.arguments;
    } else if (event.type === INTERNAL_EVENT_TYPES.USAGE_UPDATED) {
      usage = event.usage || usage;
    } else if (event.type === INTERNAL_EVENT_TYPES.RUN_COMPLETED) {
      finishReason = event.finishReason || finishReason;
      usage = event.usage || usage;
    }
  }

  return { responseId, messageId, model, created, text, reasoning, toolCalls, finishReason, usage };
}
