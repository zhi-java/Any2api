/**
 * GLM 模型配置
 *
 * 基于对 chatglm.cn 网页版后端的真实探测结果
 * 所有 model 值来自 SSE 事件中的 "model" 字段
 *
 * 探测结果：
 *   moe_5    — GLM-5 基础模型（默认对话）
 *   glm46    — GLM-4.6 旧版模型
 *   ai-search — 联网搜索专用模型
 *   v3       — CogView-3 图像生成模型
 *
 * assistant_id 均为 JS 包中定义的常量：
 *   D=65940acff94777010aa6b796 (默认对话)
 *   b=670f2b97d17824a9e557e2e9 (GLM-4.6)
 *   I=659e54b1b8006379b4b2abd6 (AI搜索)
 *   f=65a232c082ff90a2ad2f15e2 (CogView-3)
 */

const DEFAULT_ASSISTANT_ID = '65940acff94777010aa6b796';

export const GLM_MODEL_MAP = {
  /** GLM-5 深度研究（默认） */
  'glm-5': {
    assistantId: DEFAULT_ASSISTANT_ID,
    plusModel: true,
    search: false,
    chatMode: 'deep_research',
    type: 'chat',
    description: 'GLM-5 深度研究模式（默认）',
  },

  /** GLM-5 普通对话（无深度研究） */
  'glm-5-chat': {
    assistantId: DEFAULT_ASSISTANT_ID,
    plusModel: true,
    search: false,
    chatMode: '',
    type: 'chat',
    description: 'GLM-5 普通对话模式',
  },

  /** GLM-5 联网搜索 */
  'glm-5-search': {
    assistantId: DEFAULT_ASSISTANT_ID,
    plusModel: true,
    search: true,
    chatMode: '',
    type: 'chat',
    description: 'GLM-5 联网搜索',
  }
};

/**
 * 解析模型配置
 * @param {string} model - 模型名称
 * @returns {object} 模型配置
 */
export function resolveModel(model) {
  if (GLM_MODEL_MAP[model]) return GLM_MODEL_MAP[model];
  // 回退到 glm-5（深度研究模式）
  console.warn(`[GLM] Unknown model "${model}", falling back to glm-5 (deep research)`);
  return GLM_MODEL_MAP['glm-5'];
}
