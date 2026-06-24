/**
 * DeepSeek 模型配置
 *
 * 从 openai.js 提取的 MODEL_MAP
 */

import { normalizeRequestedModelName } from '../../utils/response-utils.js';

export const DEEPSEEK_MODEL_MAP = {
  'deepseek-v4-flash': 'default',
  'deepseek-v4-pro': 'expert',
  'deepseek-v4-vision': 'vision',
};

/**
 * 映射请求模型名到后端 model_type
 * 自动归一化模型名（剥离 [1m] 后缀等）
 */
export function mapModel(model) {
  const normalized = normalizeRequestedModelName(model);
  if (!normalized) throw new Error(`Invalid model: ${model}`);

  // 尝试精确匹配
  const mapped = DEEPSEEK_MODEL_MAP[normalized];
  if (mapped) return mapped;

  // 尝试模糊匹配
  if (normalized.includes('flash') || normalized.includes('default')) return 'default';
  if (normalized.includes('pro') || normalized.includes('expert') || normalized.includes('search')) return 'expert';
  if (normalized.includes('vision')) return 'vision';

  throw new Error(`Unknown model: ${model}. Available: ${Object.keys(DEEPSEEK_MODEL_MAP).join(', ')}`);
}
