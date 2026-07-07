import { createPromptPlan } from '../core/prompt-strategy.js';
import { attemptToolParseWithRetry } from '../core/tool-retry.js';
import { preprocessMessagesForToolify } from '../core/toolify-format.js';
import {
  createInternalId,
  internalMessagesToOpenAI,
  internalToolChoiceToOpenAI,
  internalToolsToOpenAI,
} from '../core/internal-request.js';
import {
  createMessageDone,
  createMessageStarted,
  createReasoningDelta,
  createReasoningDone,
  createRunCompleted,
  createRunStarted,
  createTextDelta,
  createTextDone,
  createToolCallArgumentsDelta,
  createToolCallDone,
  createToolCallStarted,
  createUsageUpdated,
} from '../core/internal-events.js';
import { InternalAPIError } from '../core/errors.js';

export function requestLikeFromInternal(internalRequest, context = {}) {
  return context?.req || {
    body: internalRequest.raw?.body || {},
    headers: internalRequest.metadata?.headers || {},
    omni: {
      promptInjectionEnabled: internalRequest.metadata?.promptInjectionEnabled,
      rawRequestJsonText: internalRequest.raw?.rawJsonText,
    },
  };
}

export function usageOutputTokens(usage) {
  if (typeof usage === 'number') return usage;
  return usage?.outputTokens ?? usage?.output_tokens ?? usage?.completion_tokens ?? usage?.total_tokens ?? 0;
}

function openAIMessagesFromInternal(internalRequest) {
  const messages = [];
  if (internalRequest.instructions?.system) {
    messages.push({ role: 'system', content: internalRequest.instructions.system });
  }
  if (internalRequest.instructions?.developer) {
    messages.push({ role: 'system', content: internalRequest.instructions.developer });
  }
  messages.push(...internalMessagesToOpenAI(internalRequest.messages));
  return messages;
}

function normalizeToolCallArguments(value) {
  if (typeof value === 'string') return value || '{}';
  try { return JSON.stringify(value ?? {}); } catch { return '{}'; }
}

function emitToolCallEvents({ requestId, responseId, messageId, toolCalls }) {
  const events = [];
  for (let index = 0; index < toolCalls.length; index++) {
    const call = toolCalls[index];
    const id = call.id || createInternalId('call');
    const name = call.function?.name || call.name;
    const args = normalizeToolCallArguments(call.function?.arguments ?? call.arguments ?? '{}');
    events.push(createToolCallStarted({ requestId, responseId, messageId, toolCallId: id, index, name }));
    if (args) events.push(createToolCallArgumentsDelta({ requestId, responseId, messageId, toolCallId: id, index, delta: args }));
    events.push(createToolCallDone({ requestId, responseId, messageId, toolCallId: id, index, name, arguments: args || '{}' }));
  }
  return events;
}

export async function collectParsedStreamContent(streamBody, parseStream) {
  let content = '';
  for await (const event of parseStream(streamBody)) {
    if (event.type === 'error') throw new Error(event.message || 'Retry stream returned an error');
    if (event.type === 'content' || event.type === 'image') {
      content += event.content || event.imageUrl || '';
    } else if (event.type === 'done') {
      break;
    }
  }
  return content;
}

function prefixBeforeBufferedToolText(processed) {
  const delta = processed?.delta || '';
  const buffered = processed?.bufferedToolText || '';
  if (!delta || !buffered) return delta;
  return delta.endsWith(buffered) ? delta.slice(0, delta.length - buffered.length) : delta;
}

export async function* runParsedStreamChannel(internalRequest, context = {}, options = {}) {
  const {
    channelName,
    startStream,
    parseStream,
    responseModel = internalRequest.model?.normalized || internalRequest.model?.requested,
    statusForError = () => 502,
  } = options;

  const req = requestLikeFromInternal(internalRequest, context);
  const requestId = internalRequest.id;
  const responseId = context.responseId || createInternalId('resp');
  const messageId = createInternalId('msg');

  const openAIMessages = openAIMessagesFromInternal(internalRequest);
  const promptPlan = createPromptPlan({
    req,
    tools: internalToolsToOpenAI(internalRequest.tools),
    toolChoice: internalToolChoiceToOpenAI(internalRequest.toolChoice),
  });
  const {
    promptInjectionDisabled,
    disabledPrompt,
    tools,
    toolChoice,
    toolCallingEnabled,
    toolInstructions,
    triggerSignal,
  } = promptPlan;
  const promptMessages = promptInjectionDisabled
    ? openAIMessages
    : preprocessMessagesForToolify(openAIMessages, triggerSignal);

  const abortController = new AbortController();
  let streamBody = null;
  let cleanup = null;
  let clientGone = false;
  let onClose = null;
  const responseStream = context?.res;
  if (responseStream?.on) {
    onClose = () => {
      clientGone = true;
      abortController.abort();
      try { streamBody?.cancel?.(); } catch {}
    };
    responseStream.on('close', onClose);
  }

  try {
    const started = await startStream({
      internalRequest,
      req,
      messages: promptMessages,
      tools,
      toolChoice,
      toolCallingEnabled,
      promptInjectionDisabled,
      disabledPrompt,
      toolInstructions,
      triggerSignal,
      promptPlan,
      signal: abortController.signal,
    });
    streamBody = started?.streamBody || started;
    cleanup = started?.cleanup || null;
    const retryToolRequest = started?.retryToolRequest || null;

    if (clientGone || abortController.signal.aborted) {
      try { streamBody?.cancel?.(); } catch {}
      return;
    }

    yield createRunStarted({ requestId, responseId, model: responseModel, protocol: internalRequest.protocol });
    yield createMessageStarted({ requestId, responseId, messageId, role: 'assistant' });

    const detector = toolCallingEnabled ? promptPlan.createStreamDetector() : null;
    let rawContent = '';
    let visibleContent = '';
    let reasoningContent = '';
    let usage = null;
    let emittedText = false;
    let upstreamError = null;
    let detectedToolCalls = null;
    let pendingToolFailureText = '';
    let pendingToolFailureResult = null;

    const emitDelta = function* (delta) {
      if (!delta) return;
      visibleContent += delta;
      emittedText = true;
      yield createTextDelta({ requestId, responseId, messageId, delta });
    };

    for await (const event of parseStream(streamBody)) {
      if (clientGone || abortController.signal.aborted) break;
      if (event.type === 'error') {
        upstreamError = event.message || `${channelName} upstream returned an error`;
        try { await streamBody?.cancel?.(); } catch {}
        break;
      }
      if (event.type === 'content' || event.type === 'image') {
        const content = event.content || event.imageUrl || '';
        rawContent += content;
        if (detector) {
          const processed = detector.process(content);
          if (processed.parseFailure) {
            pendingToolFailureText += processed.bufferedToolText || '';
            pendingToolFailureResult = processed.failureResult || pendingToolFailureResult;
            for (const deltaEvent of emitDelta(prefixBeforeBufferedToolText(processed))) yield deltaEvent;
          } else if (pendingToolFailureText) {
            pendingToolFailureText += processed.delta || '';
          } else {
            for (const deltaEvent of emitDelta(processed.delta)) yield deltaEvent;
          }
          if (processed.completed && processed.toolCalls?.length) {
            detectedToolCalls = processed.toolCalls;
            break;
          }
        } else {
          for (const deltaEvent of emitDelta(content)) yield deltaEvent;
        }
        if (event.usage) {
          usage = event.usage;
          yield createUsageUpdated({ requestId, responseId, usage: { outputTokens: usageOutputTokens(usage) } });
        }
      } else if (event.type === 'tool_calls') {
        if (event.toolCalls?.length) {
          detectedToolCalls = event.toolCalls;
          break;
        }
      } else if (event.type === 'thinking' || event.type === 'research') {
        const content = event.content || '';
        reasoningContent += content;
        yield createReasoningDelta({ requestId, responseId, messageId, delta: content });
        if (event.usage) {
          usage = event.usage;
          yield createUsageUpdated({ requestId, responseId, usage: { outputTokens: usageOutputTokens(usage) } });
        }
      } else if (event.type === 'usage') {
        usage = event.usage;
        yield createUsageUpdated({ requestId, responseId, usage: { outputTokens: usageOutputTokens(usage) } });
      } else if (event.type === 'done') {
        if (event.usage) usage = event.usage;
        break;
      }
    }

    if (detectedToolCalls?.length) {
      try { await streamBody?.cancel?.(); } catch {}
    }

    if (upstreamError) {
      throw new InternalAPIError(upstreamError, { status: 502, type: 'api_error' });
    }

    if (detector && !detectedToolCalls) {
      const finished = detector.finish();
      if (finished.parseFailure) {
        pendingToolFailureText += finished.bufferedToolText || '';
        pendingToolFailureResult = finished.failureResult || pendingToolFailureResult;
        for (const deltaEvent of emitDelta(prefixBeforeBufferedToolText(finished))) yield deltaEvent;
      } else if (pendingToolFailureText) {
        pendingToolFailureText += finished.delta || '';
      } else {
        for (const deltaEvent of emitDelta(finished.delta)) yield deltaEvent;
      }
      if (finished.completed && finished.toolCalls?.length) {
        detectedToolCalls = finished.toolCalls;
      }
    }

    if (pendingToolFailureText && !detectedToolCalls) {
      if (cleanup) {
        cleanup();
        cleanup = null;
      }
      let retryResult = null;
      try {
        retryResult = await attemptToolParseWithRetry({
          content: pendingToolFailureText,
          messages: promptMessages,
          promptPlan,
          retryToolRequest,
          signal: abortController.signal,
        });
      } catch (err) {
        console.warn(`[${channelName}] Tool retry failed, falling back to original buffered content: ${err.message}`);
      }
      if (retryResult?.toolCalls?.length) {
        detectedToolCalls = retryResult.toolCalls;
      } else {
        for (const deltaEvent of emitDelta(pendingToolFailureText)) yield deltaEvent;
      }
    }

    if (reasoningContent) yield createReasoningDone({ requestId, responseId, messageId, text: reasoningContent });
    if (emittedText || visibleContent) yield createTextDone({ requestId, responseId, messageId, text: visibleContent });

    if (detectedToolCalls?.length) {
      for (const toolEvent of emitToolCallEvents({ requestId, responseId, messageId, toolCalls: detectedToolCalls })) yield toolEvent;
    }

    yield createMessageDone({ requestId, responseId, messageId, status: 'completed' });
    yield createRunCompleted({
      requestId,
      responseId,
      finishReason: detectedToolCalls?.length ? 'tool_calls' : 'stop',
      usage: { outputTokens: usageOutputTokens(usage) || Math.round((visibleContent.length + reasoningContent.length) / 4) },
    });
  } catch (err) {
    if (err.name === 'AbortError') return;
    if (err instanceof InternalAPIError) throw err;
    throw new InternalAPIError(err.message || `${channelName} upstream error`, {
      status: statusForError(err),
      type: 'api_error',
      cause: err,
    });
  } finally {
    if (responseStream?.off && onClose) responseStream.off('close', onClose);
    if (cleanup) cleanup();
  }
}
