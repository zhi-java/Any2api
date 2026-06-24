/**
 * Notion AI 渠道统一入口
 *
 * 导出标准接口供路由层使用，与 deepseek/index.js、glm/index.js 一致。
 */

import { handleOpenAICompletion, handleClaudeMessages } from './handlers.js';
import { NOTION_MODELS, isNotionModel } from './models.js';

export default {
  // OpenAI 格式处理器
  handleOpenAI: handleOpenAICompletion,

  // Claude 格式处理器
  handleClaude: handleClaudeMessages,

  // 模型配置
  models: NOTION_MODELS,

  // 模型判断函数
  isNotionModel,

  // 模型列表处理器
  handleModels(req, res) {
    const data = NOTION_MODELS.map((id) => ({
      id,
      object: 'model',
      created: 1700000000,
      owned_by: 'notion',
    }));
    res.json({ object: 'list', data });
  },
};

// 同时导出命名导出以兼容后续改动
export { handleOpenAICompletion, handleClaudeMessages, NOTION_MODELS, isNotionModel };