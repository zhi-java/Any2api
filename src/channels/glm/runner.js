import { convertMessages, glmChatCompletion } from './client.js';
import { resolveModel } from './models.js';
import { GlmTokenManager } from './token-manager.js';
import { parseGLMStream } from './stream-parser.js';
import { collectUploadableParts } from '../../utils/message-files.js';
import { collectParsedStreamContent, runParsedStreamChannel } from '../common-internal-runner.js';

export const glmTokenManager = new GlmTokenManager();

let glmQueueTail = Promise.resolve();

async function acquireGlmSlot() {
  let release;
  const current = new Promise(resolve => { release = resolve; });
  const previous = glmQueueTail;
  glmQueueTail = previous.then(() => current, () => current);
  await previous.catch(() => {});
  let released = false;
  return () => {
    if (released) return;
    released = true;
    release();
  };
}

function getGlmErrorStatus(err) {
  const message = err?.message || '';
  if (/GLM API error 401/i.test(message)) return 503;
  if (/GLM API error/i.test(message)) return 503;
  if (/token/i.test(message)) return 503;
  return 500;
}

export function isGlmSearchEnabled(reqBody = {}) {
  return Boolean(reqBody.enable_search ?? reqBody.search_enabled ?? false);
}

export function glmChatModeForRequest(modelConfig, searchEnabled) {
  return searchEnabled ? (modelConfig.chatMode || '') : '';
}

export function glmRuntimeOptionsForRequest(modelConfig, reqBody = {}, toolCallingEnabled = false) {
  if (toolCallingEnabled) {
    return { plusModel: false, searchEnabled: false, chatMode: '' };
  }
  const searchEnabled = isGlmSearchEnabled(reqBody);
  return {
    plusModel: modelConfig.plusModel,
    searchEnabled,
    chatMode: glmChatModeForRequest(modelConfig, searchEnabled),
  };
}

export async function* runGLM(internalRequest, context = {}) {
  const requestedModel = internalRequest.model?.normalized || internalRequest.model?.requested;
  const modelConfig = resolveModel(requestedModel);

  yield* runParsedStreamChannel(internalRequest, context, {
    channelName: 'GLM',
    parseStream: parseGLMStream,
    responseModel: requestedModel,
    statusForError: getGlmErrorStatus,
    async startStream({ req, messages, promptInjectionDisabled, disabledPrompt, toolInstructions, toolCallingEnabled, signal }) {
      // GLM Web guest/session mode rejects overlapping generations with
      // status=10061 (“请等待其他对话生成完毕”). Hold a channel-wide slot until the
      // response stream is fully consumed so parallel API requests queue instead
      // of producing empty/error-only protocol responses.
      const releaseGlmSlot = await acquireGlmSlot();
      try {
        const glmMessages = promptInjectionDisabled
          ? [{ role: 'user', content: [{ type: 'text', text: disabledPrompt }] }]
          : convertMessages(messages, { toolInstructions });
        const attachments = collectUploadableParts(messages);
        const runtimeOptions = glmRuntimeOptionsForRequest(modelConfig, req.body || {}, toolCallingEnabled);
        const streamBody = await glmChatCompletion(glmMessages, {
          assistantId: modelConfig.assistantId,
          plusModel: runtimeOptions.plusModel,
          searchEnabled: runtimeOptions.searchEnabled,
          chatMode: runtimeOptions.chatMode,
          conversationId: req.headers?.['x-conversation-id'] || '',
          attachments,
          tokenManager: glmTokenManager,
          signal,
        });
        return {
          streamBody,
          cleanup: releaseGlmSlot,
          async retryToolRequest({ retryPrompt, currentContent, messages: retryMessages, signal: retrySignal }) {
            const releaseRetrySlot = await acquireGlmSlot();
            try {
              const glmRetryMessages = convertMessages([
                ...retryMessages,
                { role: 'assistant', content: [{ type: 'text', text: currentContent || '' }] },
                { role: 'user', content: [{ type: 'text', text: retryPrompt }] },
              ], { toolInstructions });
              const retryRuntimeOptions = glmRuntimeOptionsForRequest(modelConfig, req.body || {}, toolCallingEnabled);
              const retryStream = await glmChatCompletion(glmRetryMessages, {
                assistantId: modelConfig.assistantId,
                plusModel: retryRuntimeOptions.plusModel,
                searchEnabled: retryRuntimeOptions.searchEnabled,
                chatMode: retryRuntimeOptions.chatMode,
                conversationId: '',
                attachments: [],
                tokenManager: glmTokenManager,
                signal: retrySignal || signal,
              });
              return await collectParsedStreamContent(retryStream, parseGLMStream);
            } finally {
              releaseRetrySlot();
            }
          },
        };
      } catch (err) {
        releaseGlmSlot();
        throw err;
      }
    },
  });
}
