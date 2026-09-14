import { getConfig } from '../../services/config-store.js';
import { completion, parseSSEStream } from '../../utils/sse.js';
import { resolveUploadableToRefId } from '../../services/upload.js';
import { enqueueRequest, dispatchQueued } from '../../services/queue.js';
import { getConversationBinding, getRecentToolCallIndex, getResponseToolCallIndex, resolveConversation, recordResponseMessageId } from '../../services/conversation.js';
import {
  buildLatestPrompt,
  buildPromptFromMessages,
  latestDeltaStartIndex,
} from '../../utils/response-utils.js';
import { createPromptPlan } from '../../core/prompt-strategy.js';
import { attemptToolParseWithRetry, getMissingToolCallRetryPrompt, isMissingToolCallIntent } from '../../core/tool-retry.js';
import { preprocessMessagesForToolify } from '../../core/toolify-format.js';
import { collectParsedStreamContent } from '../common-internal-runner.js';
import { collectUploadableParts, hasUploadableParts } from '../../utils/message-files.js';
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
    omni: {
      promptInjectionEnabled: internalRequest.metadata?.promptInjectionEnabled,
      rawRequestJsonText: internalRequest.raw?.rawJsonText,
    },
  };
}

function usageOutputTokens(usage) {
  if (typeof usage === 'number') return usage;
  return usage?.output_tokens ?? usage?.completion_tokens ?? usage?.total_tokens ?? 0;
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
  const toolResultIds = openAIMessages
    .filter(message => message?.role === 'tool')
    .map(message => message.tool_call_id || message.toolCallId)
    .filter(Boolean);
  const previousToolCalls = new Map([
    ...getResponseToolCallIndex(internalRequest.conversation?.previousResponseId),
    ...getRecentToolCallIndex(toolResultIds),
  ]);
  const promptMessages = promptInjectionDisabled
    ? openAIMessages
    : preprocessMessagesForToolify(openAIMessages, triggerSignal, previousToolCalls);

  const fullPrompt = promptInjectionDisabled
    ? disabledPrompt
    : promptWithToolInstructions(promptMessages, toolInstructions);

  const binding = getConversationBinding(req, openAIMessages);
  const explicitConversationId = internalRequest.conversation?.id
    || (getConfig().runtime.enableConversationAffinity ? internalRequest.conversation?.previousResponseId : null);
  const conversationId = explicitConversationId || binding.conversationId;
  // 显式指定会话 ID 时增量范围未知，退回启发式截取（最后一条 assistant 之后）。
  const matchedPrefixLength = explicitConversationId ? -1 : binding.matchedPrefixLength;

  // preprocessMessagesForToolify 逐条 1:1 映射，openAIMessages 的前缀匹配
  // 下标可以直接用于 promptMessages。
  const deltaStart = promptInjectionDisabled ? null : latestDeltaStartIndex(promptMessages, matchedPrefixLength);
  const latestPrompt = promptInjectionDisabled
    ? fullPrompt
    : deltaStart != null
      ? promptWithToolInstructions(promptMessages.slice(deltaStart), toolInstructions)
      : latestPromptWithToolInstructions(promptMessages, toolInstructions);

  const thinkingEnabled = internalRequest.generation?.reasoning?.enabled ?? req.body?.thinking_enabled ?? true;
  // DeepSeek Web search may return planning/thinking without a final answer;
  // default it off for API determinism unless the caller explicitly opts in.
  const searchEnabled = req.body?.search_enabled ?? false;
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

  // 模型合并后唯一模型即具备视觉能力，上传型内容直接走视觉 slot。
  let refFileIds = [];
  if (hasUploadableParts(openAIMessages)) {
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
          // fresh/轮换的会话（promptMode 'full'）没有历史，必须按全量模式发送，
          // 因此只有既有会话续传时才把 affinity 报告为 true（getPrompt 据此选增量）。
          return {
            sessionId: resolved.sessionId,
            parentMessageId: resolved.parentMessageId,
            affinity: resolved.affinity && resolved.promptMode === 'latest',
          };
        }
      : null;
    const getPrompt = (affinity) => (promptInjectionDisabled || affinity) ? latestPrompt : fullPrompt;

    const completionResult = await completion({
      modelType,
      prompt: fullPrompt,
      thinkingEnabled,
      searchEnabled,
      refFileIds,
      preferVision: true,
      resolveSession: makeResolveSession(modelType),
      getPrompt,
      signal: abortController.signal,
    });

    streamBody = completionResult.body;
    slot = completionResult.slot;
    if (clientGone || abortController.signal.aborted) {
      try { streamBody.cancel(); } catch {}
      return;
    }

    const responseModel = requestedModel;
    yield createRunStarted({ requestId, responseId, model: responseModel, protocol: internalRequest.protocol });

    const detector = toolCallingEnabled ? promptPlan.createStreamDetector() : null;
    let rawContent = '';
    let visibleContent = '';
    let reasoningContent = '';
    let usage = 0;
    let emittedText = false;
    let messageStarted = false;
    let detectedToolCalls = null;
    let pendingToolFailureText = '';
    let pendingToolFailureResult = null;

    const ensureMessageStarted = function* () {
      if (messageStarted) return;
      messageStarted = true;
      yield createMessageStarted({ requestId, responseId, messageId, role: 'assistant' });
    };

    const emitText = function* (delta) {
      if (!delta) return;
      for (const event of ensureMessageStarted()) yield event;
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

    const releaseSlot = () => {
      if (slot) {
        slot.release();
        dispatchQueued();
        slot = null;
      }
    };
    const retryToolRequest = async ({ retryPrompt, currentContent, messages: retryMessages, signal }) => {
      const retryMessagesWithPrompt = [
        ...retryMessages,
        { role: 'assistant', content: [{ type: 'text', text: currentContent || '' }] },
        { role: 'user', content: [{ type: 'text', text: retryPrompt }] },
      ];
      const retryFullPrompt = promptWithToolInstructions(retryMessagesWithPrompt, toolInstructions);
      const retryResult = await completion({
        modelType,
        prompt: retryFullPrompt,
        thinkingEnabled,
        searchEnabled: false,
        refFileIds: [],
        preferVision: true,
        signal: signal || abortController.signal,
      });
      const retrySlot = retryResult.slot;
      try {
        return await collectParsedStreamContent(retryResult.body, (body) => parseSSEStream(body, { signal: signal || abortController.signal }));
      } finally {
        retrySlot?.release?.();
        dispatchQueued();
      }
    };

    if (pendingToolFailureText && !detectedToolCalls) {
      releaseSlot();
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

    // 收尾兜底：模型用 `工具名({...})` 伪代码文本表示调用时，流式检测器
    // 不会拦截（无 XML 标记），文本已流出无法撤回；此处仍解析/纠错重试
    // 把 tool_calls 救回来，避免客户端收到一段"宣称调用"的文本后任务死锁。
    if (!detectedToolCalls && !pendingToolFailureText && toolCallingEnabled && rawContent && promptPlan.parseToolCallsDetailed) {
      const lateResult = promptPlan.parseToolCallsDetailed(rawContent);
      if (lateResult?.toolCalls?.length) {
        detectedToolCalls = lateResult.toolCalls;
        // late recovery 命中时，rawContent 里通常包含非标准工具文本
        // （如 <ApplyPatch> 或 ToolName({...})）。最终聚合 content 只保留
        // 工具调用前的说明文本，避免把 patch/伪调用主体当正文返回。
        visibleContent = lateResult.content || '';
        emittedText = !!visibleContent;
      } else if (lateResult?.failureType && lateResult.failureType !== 'no_fc') {
        releaseSlot();
        try {
          const lateRetry = await attemptToolParseWithRetry({
            content: rawContent,
            messages: promptMessages,
            promptPlan,
            retryToolRequest,
            signal: abortController.signal,
          });
          if (lateRetry?.toolCalls?.length) detectedToolCalls = lateRetry.toolCalls;
        } catch (err) {
          console.warn(`[DeepSeek] Late tool recovery failed: ${err.message}`);
        }
      } else if (lateResult?.failureType === 'no_fc' && isMissingToolCallIntent(rawContent, promptPlan.tools)) {
        releaseSlot();
        try {
          const retryContent = await retryToolRequest({
            retryPrompt: getMissingToolCallRetryPrompt(rawContent, promptPlan.triggerSignal, promptPlan.tools),
            currentContent: rawContent,
            messages: promptMessages,
            signal: abortController.signal,
            failureType: 'missing_tool_call',
          });
          const missingRetry = promptPlan.parseToolCallsDetailed(retryContent);
          if (missingRetry?.toolCalls?.length) detectedToolCalls = missingRetry.toolCalls;
        } catch (err) {
          console.warn(`[DeepSeek] Missing tool-call recovery failed: ${err.message}`);
        }
      }
    }

    // 注意：不要在流结束后把已流式发出的 message 文本"回填"成 reasoning。
    // 那样做无法流式（必须等到检测到 tool_call 才知道），会导致 Codex 端
    // 思考内容在末尾一次性出现。真正的思考来自上游 thinking 通道，已逐字流式；
    // 工具调用前的说明文本保持为 message 文本，同样逐字流式。
    if (reasoningContent) yield createReasoningDone({ requestId, responseId, messageId, text: reasoningContent });
    if (emittedText || visibleContent) {
      for (const event of ensureMessageStarted()) yield event;
      yield createTextDone({ requestId, responseId, messageId, text: visibleContent });
    }

    if (detectedToolCalls?.length) {
      for (const event of ensureMessageStarted()) yield event;
      for (const toolEvent of emitToolCallEvents({ requestId, responseId, messageId, toolCalls: detectedToolCalls })) {
        yield toolEvent;
      }
    }

    if (messageStarted || emittedText || visibleContent || detectedToolCalls?.length) {
      for (const event of ensureMessageStarted()) yield event;
      yield createMessageDone({ requestId, responseId, messageId, status: 'completed' });
    }
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
