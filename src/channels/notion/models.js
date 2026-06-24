/**
 * Notion AI 渠道 — 模型定义
 *
 * 客户端请求的模型名 → Notion 内部模型名映射
 *
 * Notion 内部模型名（go 项目 models.go builtinModelDefinitions）：
 *   almond-croissant-low  → Sonnet 4.6
 *   apricot-sorbet-medium → Opus 4.7
 *   avocado-froyo-medium  → Opus 4.6
 *   anthropic-haiku-4.5   → Haiku 4.5
 *   galette-medium-thinking → Gemini 3.1 Pro
 *   oatmeal-cookie        → GPT-5.2
 *   oval-kumquat-medium   → GPT-5.4
 *   vertex-gemini-2.5-flash → Gemini 2.5 Flash
 *   gingerbread           → Gemini 3 Flash
 *   oregon-grape-medium   → GPT-5.4 Mini
 *   otaheite-apple-medium → GPT-5.4 Nano
 *   fireworks-minimax-m2.5 → MiniMax M2.5
 */

/**
 * 模型映射表
 * key: 客户端请求时使用的模型名
 * value: Notion 内部的 model 字段值（用于 config step）
 */
export const MODEL_MAP = {
  // Anthropic 系列
  'claude-sonnet-4-6': 'almond-croissant-low',
  'claude-opus-4-6': 'avocado-froyo-medium',
  'claude-opus-4-7': 'apricot-sorbet-medium',
  'claude-opus-4-8': 'apricot-sorbet-medium',
  'claude-haiku-4-5': 'anthropic-haiku-4-5',

  // OpenAI 系列
  'gpt-5.2': 'oatmeal-cookie',
  'gpt-5.4': 'oval-kumquat-medium',
  'gpt-5.5': 'oval-kumquat-medium',

  // Gemini 系列
  'gemini-2.5-flash': 'vertex-gemini-2.5-flash',
  'gemini-3.1-pro': 'galette-medium-thinking',
  'gemini-3-flash': 'gingerbread',

  // 其他
  'minimax-m2.5': 'fireworks-minimax-m2.5',
  'grok-4.3': 'grok-4.3',
  'grok-build-0.1': 'grok-build-0.1',
  'kimi-k2.6': 'kimi-k2.6',
  'deepseek-v4-pro': 'deepseek-v4-pro',
  'glm-5.2': 'glm-5.2',
};

/** 客户端可用的模型名列表 */
export const NOTION_MODELS = Object.keys(MODEL_MAP);

/**
 * 判断模型名是否属于 Notion 渠道
 * @param {string} modelName
 * @returns {boolean}
 */
export function isNotionModel(modelName) {
  return modelName in MODEL_MAP;
}

/**
 * 获取 Notion 内部模型名
 * @param {string} publicModel
 * @returns {string}
 */
export function toNotionModel(publicModel) {
  return MODEL_MAP[publicModel] || publicModel;
}

/**
 * 获取展示名
 * @param {string} publicModel
 * @returns {string}
 */
export function getDisplayName(publicModel) {
  return publicModel;
}