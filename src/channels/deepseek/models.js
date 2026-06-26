/**
 * DeepSeek 模型配置
 *
 * 从 openai.js 提取的 MODEL_MAP
 */

import { normalizeRequestedModelName } from '../../utils/response-utils.js';

export const DEEPSEEK_MODEL_MAP = {
  'deepseek-v4-flash': 'default',
  'deepseek-v4-pro': 'expert',
};

/**
 * 映射请求模型名到后端 model_type
 * 只允许白名单中的两个模型
 */
export function mapModel(model) {
  const normalized = normalizeRequestedModelName(model);
  if (!normalized) throw new Error(`Invalid model: ${model}`);

  const mapped = DEEPSEEK_MODEL_MAP[normalized];
  if (mapped) return mapped;

  throw new Error(
    `Unknown model: ${model}. Available: ${Object.keys(DEEPSEEK_MODEL_MAP).join(', ')}`
  );
}
