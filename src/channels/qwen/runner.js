import { QwenTokenManager } from './auth.js';
import { QwenRequestQueue } from './queue.js';
import { buildQwenMessages, qwenChatCompletion } from './client.js';
import { resolveModel } from './models.js';
import { parseQwenStream } from './stream-parser.js';
import { collectUploadableParts } from '../../utils/message-files.js';
import { collectParsedStreamContent, runParsedStreamChannel } from '../common-internal-runner.js';

export const qwenTokenManager = new QwenTokenManager();
export const qwenRequestQueue = new QwenRequestQueue(qwenTokenManager);

function isThinkingEnabled(modelConfig, reqBody) {
  if (modelConfig.forceThinking) return true;
  return Boolean(reqBody.enable_thinking ?? reqBody.thinking_enabled ?? false);
}

function isSearchEnabled(modelConfig, reqBody) {
  if (modelConfig.chatMode === 'deep_research') return true;
  return Boolean(reqBody.enable_search ?? reqBody.search_enabled ?? false);
}

export function qwenRuntimeOptionsForRequest(modelConfig, reqBody = {}, toolCallingEnabled = false) {
  if (toolCallingEnabled) {
    return { chatMode: 't2t', thinkingEnabled: false, searchEnabled: false };
  }
  return {
    chatMode: modelConfig.chatMode || 't2t',
    thinkingEnabled: isThinkingEnabled(modelConfig, reqBody),
    searchEnabled: false,
  };
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

export async function* runQwen(internalRequest, context = {}) {
  const requestedModel = internalRequest.model?.normalized || internalRequest.model?.requested;
  const modelConfig = resolveModel(requestedModel);

  yield* runParsedStreamChannel(internalRequest, context, {
    channelName: 'Qwen',
    parseStream: parseQwenStream,
    responseModel: requestedModel,
    statusForError: getQwenErrorStatus,
    async startStream({ req, messages, promptInjectionDisabled, disabledPrompt, toolInstructions, toolCallingEnabled, signal }) {
      const slot = await qwenRequestQueue.enqueueRequest();
      let completed = false;
      try {
        const qwenMessages = promptInjectionDisabled
          ? [{ role: 'user', content: disabledPrompt }]
          : buildQwenMessages(messages, { toolInstructions });
        const runtimeOptions = qwenRuntimeOptionsForRequest(modelConfig, req.body || {}, toolCallingEnabled);
        const streamBody = await qwenChatCompletion({
          token: slot.token,
          model: modelConfig.baseModel,
          messages: qwenMessages,
          attachments: collectUploadableParts(messages),
          chatMode: runtimeOptions.chatMode,
          thinkingEnabled: runtimeOptions.thinkingEnabled,
          searchEnabled: runtimeOptions.searchEnabled,
          signal,
          tokenManager: qwenTokenManager,
        });
        return {
          streamBody,
          cleanup() {
            if (completed) return;
            completed = true;
            slot.release();
            qwenRequestQueue.dispatchQueued();
          },
          async retryToolRequest({ retryPrompt, currentContent, messages: retryMessages, signal: retrySignal }) {
            const retrySlot = await qwenRequestQueue.enqueueRequest();
            let retryCompleted = false;
            try {
              const qwenRetryMessages = buildQwenMessages([
                ...retryMessages,
                { role: 'assistant', content: [{ type: 'text', text: currentContent || '' }] },
                { role: 'user', content: [{ type: 'text', text: retryPrompt }] },
              ], { toolInstructions });
              const retryRuntimeOptions = qwenRuntimeOptionsForRequest(modelConfig, req.body || {}, toolCallingEnabled);
              const retryStream = await qwenChatCompletion({
                token: retrySlot.token,
                model: modelConfig.baseModel,
                messages: qwenRetryMessages,
                attachments: [],
                chatMode: retryRuntimeOptions.chatMode,
                thinkingEnabled: retryRuntimeOptions.thinkingEnabled,
                searchEnabled: retryRuntimeOptions.searchEnabled,
                signal: retrySignal || signal,
                tokenManager: qwenTokenManager,
              });
              return await collectParsedStreamContent(retryStream, parseQwenStream);
            } finally {
              if (!retryCompleted) {
                retryCompleted = true;
                retrySlot.release();
                qwenRequestQueue.dispatchQueued();
              }
            }
          },
        };
      } catch (err) {
        if (!completed) {
          completed = true;
          slot.release();
          qwenRequestQueue.dispatchQueued();
        }
        throw err;
      }
    },
  });
}
