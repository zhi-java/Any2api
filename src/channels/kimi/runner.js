import { KimiTokenManager } from './auth.js';
import { buildKimiMessages, kimiChatCompletion } from './client.js';
import { resolveModel } from './models.js';
import { parseKimiStream } from './stream-parser.js';
import { collectUploadableParts } from '../../utils/message-files.js';
import { collectParsedStreamContent, runParsedStreamChannel } from '../common-internal-runner.js';

export const kimiTokenManager = new KimiTokenManager();

function isThinkingEnabled(modelConfig, reqBody) {
  if (modelConfig.thinking) return true;
  return Boolean(reqBody.enable_thinking ?? reqBody.thinking_enabled ?? false);
}

function getKimiErrorStatus(err) {
  const message = err?.message || '';
  if (/No Kimi credentials/i.test(message)) return 503;
  if (/expired/i.test(message)) return 503;
  if (/Kimi completion failed:/i.test(message)) return 503;
  if (/Kimi file upload failed:/i.test(message)) return 503;
  return 500;
}

export async function* runKimi(internalRequest, context = {}) {
  const requestedModel = internalRequest.model?.normalized || internalRequest.model?.requested;
  const modelConfig = resolveModel(requestedModel);

  yield* runParsedStreamChannel(internalRequest, context, {
    channelName: 'Kimi',
    parseStream: parseKimiStream,
    responseModel: requestedModel,
    statusForError: getKimiErrorStatus,
    async startStream({ req, messages, promptInjectionDisabled, disabledPrompt, toolInstructions, signal }) {
      const slot = kimiTokenManager.acquireToken();
      if (!slot) throw new Error(kimiTokenManager.getUnavailableReason());
      let completed = false;
      try {
        const prompt = promptInjectionDisabled ? disabledPrompt : buildKimiMessages(messages, { toolInstructions });
        const streamBody = await kimiChatCompletion({
          token: slot.token,
          prompt,
          attachments: collectUploadableParts(messages),
          scenario: modelConfig.scenario,
          thinkingEnabled: isThinkingEnabled(modelConfig, req.body || {}),
          signal,
          tokenManager: kimiTokenManager,
        });
        return {
          streamBody,
          cleanup() {
            if (completed) return;
            completed = true;
            slot.release();
          },
          async retryToolRequest({ retryPrompt, currentContent, messages: retryMessages, signal: retrySignal }) {
            const retrySlot = kimiTokenManager.acquireToken();
            if (!retrySlot) throw new Error(kimiTokenManager.getUnavailableReason());
            try {
              const retryPromptText = buildKimiMessages([
                ...retryMessages,
                { role: 'assistant', content: [{ type: 'text', text: currentContent || '' }] },
                { role: 'user', content: [{ type: 'text', text: retryPrompt }] },
              ], { toolInstructions });
              const retryStream = await kimiChatCompletion({
                token: retrySlot.token,
                prompt: retryPromptText,
                attachments: [],
                scenario: modelConfig.scenario,
                thinkingEnabled: isThinkingEnabled(modelConfig, req.body || {}),
                signal: retrySignal || signal,
                tokenManager: kimiTokenManager,
              });
              return await collectParsedStreamContent(retryStream, parseKimiStream);
            } finally {
              retrySlot.release();
            }
          },
        };
      } catch (err) {
        if (!completed) {
          completed = true;
          slot.release();
        }
        throw err;
      }
    },
  });
}
