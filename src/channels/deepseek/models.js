/**
 * DeepSeek 模型配置
 *
 * 从 openai.js 提取的 MODEL_MAP
 */

export const DEEPSEEK_MODEL_MAP = {
  'deepseek-v4-flash': 'default',
  'deepseek-v4-pro': 'expert',
  'deepseek-v4-vision': 'vision',
  'deepseek-v4-pro-search': 'search',
  'deepseek-v4-flash[1m]': 'default',
  'deepseek-v4-pro[1m]': 'expert',
  'deepseek-v4-vision[1m]': 'vision',
};

export function mapModel(model) {
  const mapped = DEEPSEEK_MODEL_MAP[model];
  if (!mapped) throw new Error(`Unknown model: ${model}. Available: ${Object.keys(DEEPSEEK_MODEL_MAP).join(', ')}`);
  return mapped;
}
