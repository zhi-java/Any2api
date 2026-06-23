/**
 * GLM 模型配置
 *
 * 定义所有支持的 GLM 模型及其参数
 */

const DEFAULT_ASSISTANT_ID = '65940acff94777010aa6b796';
const COGVIEW_ASSISTANT_ID = '65a232c082ff90a2ad2f15e2';

export const GLM_MODEL_MAP = {
  'glm-5.2':       { assistantId: DEFAULT_ASSISTANT_ID, plusModel: true,  search: false, type: 'chat' },
  'glm-4':         { assistantId: DEFAULT_ASSISTANT_ID, plusModel: false, search: false, type: 'chat' },
  'glm-4-plus':    { assistantId: DEFAULT_ASSISTANT_ID, plusModel: true,  search: false, type: 'chat' },
  'glm-4-search':  { assistantId: DEFAULT_ASSISTANT_ID, plusModel: true,  search: true,  type: 'chat' },
  'glm-4v':        { assistantId: DEFAULT_ASSISTANT_ID, plusModel: true,  search: false, type: 'vision' },
  'glm-4-flash':   { assistantId: DEFAULT_ASSISTANT_ID, plusModel: false, search: false, type: 'chat' },
  'cogview-3':     { assistantId: COGVIEW_ASSISTANT_ID, plusModel: false, search: false, type: 'image' },
};

/**
 * 解析模型配置
 * @param {string} model - 模型名称
 * @returns {object} 模型配置
 */
export function resolveModel(model) {
  return GLM_MODEL_MAP[model] || GLM_MODEL_MAP['glm-4'];
}
