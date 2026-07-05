import { completion, parseSSEStream } from '../../utils/sse.js';
import { resolveUploadableToRefId } from '../../services/upload.js';
import { enqueueRequest, dispatchQueued } from '../../services/queue.js';
import { getConversationId, resolveConversation, recordResponseMessageId } from '../../services/conversation.js';
import {
  buildLatestPrompt,
  buildPromptFromMessages,
} from '../../utils/response-utils.js';
import { createPromptPlan } from '../../core/prompt-strategy.js';
import { attemptToolParseWithRetry } from '../../core/tool-retry.js';
import { preprocessMessagesForToolify } from '../../core/toolify-format.js';
import { collectParsedStreamContent } from '../common-internal-runner.js';
import { collectUploadableParts, hasUploadableParts } from '../../utils/message-files.js';
import {
  createRuntimeContextFallbackPlan,
  DEEPSEEK_FLASH_MODEL,
  isContextFallbackEnabled,
  isContextLimitError,
  isDeepSeekProModel,
  selectContextExecutionPlan,
} from './context-budget.js';
import { mapModel } from './models.js';
import { InternalAPIError } from '../../core/errors.js';
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
} from '../../core/internal-events.js';
import {
  createInternalId,
  internalMessagesToOpenAI,
  internalToolChoiceToOpenAI,
  internalToolsToOpenAI,
} from '../../core/internal-request.js';

async function extractUploads(messages, token) {
  const refFileIds = [];
  for (const file of collectUploadableParts(messages)) {
    try {
      const fileId = await resolveUploadableToRefId(file, token);
      refFileIds.push(fileId);
    } catch (err) {
      console.error('File upload failed:', err.message);
    }
  }
  return refFileIds;
}

function promptWithToolInstructions(messages, toolInstructions) {
  return (buildPromptFromMessages(messages).trim() + (toolInstructions || '')).trim();
}

function latestPromptWithToolInstructions(messages, toolInstructions) {
  return (buildLatestPrompt(messages).trim() + (toolInstructions || '')).trim();
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

function getRequestLike(internalRequest, context) {
  return context?.req || {
    body: internalRequest.raw?.body || {},
    headers: internalRequest.metadata?.headers || {},
    any2api: {
      promptInjectionEnabled: internalRequest.metadata?.promptInjectionEnabled,
      rawRequestJsonText: internalRequest.raw?.rawJsonText,
    },
  };
}

function usageOutputTokens(usage) {
  if (typeof usage === 'number') return usage;
  return usage?.output_tokens ?? usage?.completion_tokens ?? usage?.total_tokens ?? 0;
}

async function completionWithContextFallback(initialPlan, buildArgs) {
  let plan = initialPlan;
  try {
    const result = await completion(buildArgs(plan));
    return { result, plan };
  } catch (err) {
    if (
      !plan.fallbackReason &&
      isContextFallbackEnabled() &&
      isDeepSeekProModel(plan.requestedModel) &&
      isContextLimitError(err)
    ) {
      plan = createRuntimeContextFallbackPlan(plan);
      const result = await completion(buildArgs(plan));
      return { result, plan };
    }
    throw err;
  }
}

function emitToolCallEvents({ requestId, responseId, messageId, toolCalls }) {
  const events = [];
  for (let index = 0; index < toolCalls.length; index++) {
    const call = toolCalls[index];
    const id = call.id || createInternalId('call');
    const name = call.function?.name || call.name;
    const args = call.function?.arguments ?? call.arguments ?? '{}';
    events.push(createToolCallStarted({ requestId, responseId, messageId, toolCallId: id, index, name }));
    if (args) events.push(createToolCallArgumentsDelta({ requestId, responseId, messageId, toolCallId: id, index, delta: args }));
    events.push(createToolCallDone({ requestId, responseId, messageId, toolCallId: id, index, name, arguments: args || '{}' }));
  }
  return events;
}

function prefixBeforeBufferedToolText(processed) {
  const delta = processed?.delta || '';
  const buffered = processed?.bufferedToolText || '';
  if (!delta || !buffered) return delta;
  return delta.endsWith(buffered) ? delta.slice(0, delta.length - buffered.length) : delta;
}

export async function* runDeepSeek(internalRequest, context = {}) {
  const req = getRequestLike(internalRequest, context);
  const requestedModel = internalRequest.model?.normalized || internalRequest.model?.requested;
  const modelType = mapModel(requestedModel);
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
    toolCallingEnabled,
    toolInstructions,
    triggerSignal,
  } = promptPlan;
  const promptMessages = promptInjectionDisabled
    ? openAIMessages
    : preprocessMessagesForToolify(openAIMessages, triggerSignal);

  const fullPrompt = promptInjectionDisabled
    ? disabledPrompt
    : promptWithToolInstructions(promptMessages, toolInstructions);
  const latestPrompt = promptInjectionDisabled
    ? fullPrompt
    : latestPromptWithToolInstructions(promptMessages, toolInstructions);

  const thinkingEnabled = internalRequest.generation?.reasoning?.enabled ?? req.body?.thinking_enabled ?? true;
  // DeepSeek Web search may return planning/thinking without a final answer;
  // default it off for API determinism unless the caller explicitly opts in.
  const searchEnabled = req.body?.search_enabled ?? false;
  const derivedConversationId = getConversationId(req, openAIMessages);
  const conversationId = internalRequest.conversation?.id
    || (process.env.ENABLE_CONVERSATION_AFFINITY === 'true' ? (internalRequest.conversation?.previousResponseId || derivedConversationId) : derivedConversationId);
  const requestStart = Date.now();

  let streamBody;
  let slot;
  let clientGone = false;
  const abortController = new AbortController();
  let onClose = null;
  const responseStream = context?.res;
  if (responseStream?.on) {
    onClose = () => {
      clientGone = true;
      abortController.abort();
      try { streamBody?.cancel(); } catch {}
    };
    responseStream.on('close', onClose);
  }

  let contextPlan = selectContextExecutionPlan({
    requestedModel,
    requestedModelType: modelType,
    promptForBudget: conversationId ? latestPrompt : fullPrompt,
  });

  let refFileIds = [];
  if (contextPlan.effectiveModel === DEEPSEEK_FLASH_MODEL && hasUploadableParts(openAIMessages)) {
    const uploadSlot = await enqueueRequest(true);
    try {
      refFileIds = await extractUploads(openAIMessages, uploadSlot.token);
    } finally {
      uploadSlot.release();
      dispatchQueued();
    }
  }

  try {
    const makeResolveSession = (activeModelType) => conversationId
      ? async (token) => {
          const resolved = await resolveConversation({ conversationId, modelType: activeModelType, token });
          return { sessionId: resolved.sessionId, parentMessageId: resolved.parentMessageId, affinity: resolved.affinity };
        }
      : null;
    const getPrompt = (affinity) => (promptInjectionDisabled || affinity) ? latestPrompt : fullPrompt;

    const completionResult = await completionWithContextFallback(contextPlan, (activePlan) => ({
      modelType: activePlan.modelType,
      prompt: fullPrompt,
      thinkingEnabled,
      searchEnabled,
      refFileIds,
      preferVision: activePlan.effectiveModel === DEEPSEEK_FLASH_MODEL,
      resolveSession: makeResolveSession(activePlan.modelType),
      getPrompt,
      signal: abortController.signal,
    }));

    contextPlan = completionResult.plan;
    streamBody = completionResult.result.body;
    slot = completionResult.result.slot;
    if (clientGone || abortController.signal.aborted) {
      try { streamBody.cancel(); } catch {}
      return;
    }

    const responseModel = contextPlan.effectiveModel || requestedModel;
    yield createRunStarted({ requestId, responseId, model: responseModel, protocol: internalRequest.protocol });
    yield createMessageStarted({ requestId, responseId, messageId, role: 'assistant' });

    const detector = toolCallingEnabled ? promptPlan.createStreamDetector() : null;
    let rawContent = '';
    let visibleContent = '';
    let reasoningContent = '';
    let usage = 0;
    let emittedText = false;
    let detectedToolCalls = null;
    let pendingToolFailureText = '';
    let pendingToolFailureResult = null;

    const emitText = function* (delta) {
      if (!delta) return;
      visibleContent += delta;
      emittedText = true;
      yield createTextDelta({ requestId, responseId, messageId, delta });
    };

    for await (const event of parseSSEStream(streamBody, { signal: abortController.signal })) {
      if (clientGone) break;
      if (event.type === 'error') {
        try { await streamBody?.cancel?.(); } catch {}
        throw new InternalAPIError(event.message || `DeepSeek error ${event.code}`, { status: 502, type: 'api_error', code: event.code || null });
      }
      if (event.messageIds?.responseMessageId) {
        recordResponseMessageId(conversationId, event.messageIds.responseMessageId);
      }

      if (event.type === 'content') {
        rawContent += event.content;
        if (detector) {
          const processed = detector.process(event.content);
          if (processed.parseFailure) {
            pendingToolFailureText += processed.bufferedToolText || '';
            pendingToolFailureResult = processed.failureResult || pendingToolFailureResult;
            for (const textEvent of emitText(prefixBeforeBufferedToolText(processed))) yield textEvent;
          } else if (pendingToolFailureText) {
            pendingToolFailureText += processed.delta || '';
          } else {
            for (const textEvent of emitText(processed.delta)) yield textEvent;
          }
          if (processed.completed && processed.toolCalls?.length) {
            detectedToolCalls = processed.toolCalls;
            break;
          }
        } else {
          for (const textEvent of emitText(event.content)) yield textEvent;
        }
      } else if (event.type === 'thinking') {
        reasoningContent += event.content;
        yield createReasoningDelta({ requestId, responseId, messageId, delta: event.content });
      } else if (event.type === 'usage') {
        usage = event.usage;
        yield createUsageUpdated({ requestId, responseId, usage: { outputTokens: usageOutputTokens(usage) } });
      } else if (event.type === 'done') {
        break;
      }
    }

    if (detectedToolCalls?.length) {
      try { await streamBody?.cancel?.(); } catch {}
    }

    if (detector && !detectedToolCalls) {
      const finished = detector.finish();
      if (finished.parseFailure) {
        pendingToolFailureText += finished.bufferedToolText || '';
        pendingToolFailureResult = finished.failureResult || pendingToolFailureResult;
        for (const textEvent of emitText(prefixBeforeBufferedToolText(finished))) yield textEvent;
      } else if (pendingToolFailureText) {
        pendingToolFailureText += finished.delta || '';
      } else {
        for (const textEvent of emitText(finished.delta)) yield textEvent;
      }
      if (finished.completed && finished.toolCalls?.length) {
        detectedToolCalls = finished.toolCalls;
      }
    }

    if (pendingToolFailureText && !detectedToolCalls) {
      if (slot) {
        slot.release();
        dispatchQueued();
        slot = null;
      }
      const retryToolRequest = async ({ retryPrompt, currentContent, messages: retryMessages, signal }) => {
        const retryMessagesWithPrompt = [
          ...retryMessages,
          { role: 'assistant', content: [{ type: 'text', text: currentContent || '' }] },
          { role: 'user', content: [{ type: 'text', text: retryPrompt }] },
        ];
        const retryFullPrompt = promptWithToolInstructions(retryMessagesWithPrompt, toolInstructions);
        const retryResult = await completionWithContextFallback(contextPlan, (activePlan) => ({
          modelType: activePlan.modelType,
          prompt: retryFullPrompt,
          thinkingEnabled,
          searchEnabled: false,
          refFileIds: [],
          preferVision: activePlan.effectiveModel === DEEPSEEK_FLASH_MODEL,
          signal: signal || abortController.signal,
        }));
        contextPlan = retryResult.plan;
        const retrySlot = retryResult.result.slot;
        try {
          return await collectParsedStreamContent(retryResult.result.body, (body) => parseSSEStream(body, { signal: signal || abortController.signal }));
        } finally {
          retrySlot?.release?.();
          dispatchQueued();
        }
      };
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
        console.warn(`[DeepSeek] Tool retry failed, falling back to original buffered content: ${err.message}`);
      }
      if (retryResult?.toolCalls?.length) {
        detectedToolCalls = retryResult.toolCalls;
      } else {
        for (const textEvent of emitText(pendingToolFailureText)) yield textEvent;
      }
    }

    if (reasoningContent) yield createReasoningDone({ requestId, responseId, messageId, text: reasoningContent });
    if (emittedText || visibleContent) yield createTextDone({ requestId, responseId, messageId, text: visibleContent });

    if (detectedToolCalls?.length) {
      for (const toolEvent of emitToolCallEvents({ requestId, responseId, messageId, toolCalls: detectedToolCalls })) {
        yield toolEvent;
      }
    }

    yield createMessageDone({ requestId, responseId, messageId, status: 'completed' });
    yield createRunCompleted({
      requestId,
      responseId,
      finishReason: detectedToolCalls?.length ? 'tool_calls' : 'stop',
      usage: { outputTokens: usageOutputTokens(usage) || Math.round((visibleContent.length + reasoningContent.length) / 4) },
    });

    const totalDuration = Date.now() - requestStart;
    if (context?.recordMetrics && totalDuration > 0) {
      context.recordMetrics(responseModel, usageOutputTokens(usage), totalDuration);
    }
  } catch (err) {
    if (err.name === 'AbortError') return;
    if (err instanceof InternalAPIError) throw err;
    try { await streamBody?.cancel?.(); } catch {}
    throw new InternalAPIError(err.message || 'DeepSeek upstream error', {
      status: 502,
      type: 'api_error',
      cause: err,
    });
  } finally {
    if (responseStream?.off && onClose) responseStream.off('close', onClose);
    if (slot) {
      slot.release();
      dispatchQueued();
    }
  }
}
