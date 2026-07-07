import { normalizeRequestedModelName } from '../../utils/response-utils.js';
import { getConfig } from '../../services/config-store.js';

export const DEEPSEEK_FLASH_MODEL = 'deepseek-v4-flash';
export const DEEPSEEK_FLASH_MODEL_TYPE = 'default';

const PRO_MODEL_NAMES = new Set(['deepseek-v4-pro']);

export function estimatePromptTokens(text) {
  const value = String(text || '');
  if (!value) return 0;

  const bytes = Buffer.byteLength(value, 'utf8');
  const chars = [...value].length;
  if (bytes === chars) return Math.ceil(chars / 4);

  return Math.ceil(Math.max(bytes / 3, chars / 4));
}

export function getProSafeInputTokens() {
  return getConfig().deepseek.proSafeInputTokens;
}

export function isDeepSeekProModel(model) {
  return PRO_MODEL_NAMES.has(normalizeRequestedModelName(model));
}

export function isContextFallbackEnabled() {
  return getConfig().deepseek.contextFallback;
}

export function isContextLimitError(err) {
  const message = String(err?.message || err || '');
  const lower = message.toLowerCase();
  if (!lower) return false;
  if (lower.includes('rate limited') || lower.includes('session rate limited')) return false;

  return /context[_\s-]*(length|limit|window|exceeded)|maximum context|prompt.*too long|input.*too long|too many tokens|token.*(limit|exceed)|上下文.*(超|长|限制)|输入.*(过长|超出)/i.test(message);
}

export function selectContextExecutionPlan({
  requestedModel,
  requestedModelType,
  promptForBudget,
  safeInputTokens = getProSafeInputTokens(),
  fallbackEnabled = isContextFallbackEnabled(),
}) {
  const normalizedModel = normalizeRequestedModelName(requestedModel);
  const estimatedPromptTokens = estimatePromptTokens(promptForBudget);
  const canFallback = fallbackEnabled && PRO_MODEL_NAMES.has(normalizedModel);
  const shouldFallback = canFallback && estimatedPromptTokens > safeInputTokens;

  if (!shouldFallback) {
    return {
      requestedModel: normalizedModel,
      effectiveModel: normalizedModel,
      modelType: requestedModelType,
      estimatedPromptTokens,
      safeInputTokens,
      fallbackReason: null,
    };
  }

  return {
    requestedModel: normalizedModel,
    effectiveModel: DEEPSEEK_FLASH_MODEL,
    modelType: DEEPSEEK_FLASH_MODEL_TYPE,
    estimatedPromptTokens,
    safeInputTokens,
    fallbackReason: 'estimated_context_exceeded',
  };
}

export function createRuntimeContextFallbackPlan(previousPlan) {
  return {
    ...previousPlan,
    effectiveModel: DEEPSEEK_FLASH_MODEL,
    modelType: DEEPSEEK_FLASH_MODEL_TYPE,
    fallbackReason: 'upstream_context_exceeded',
  };
}
