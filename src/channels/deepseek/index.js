/**
 * DeepSeek 渠道统一入口
 *
 * 导出标准接口供路由层使用
 */

import { handleOpenAICompletion, handleDeepSeekClaude, handleOpenAIModels, handleDeepSeekModels } from './handlers.js';
import { handleDeepSeekCompletion } from './native.js';
import { DEEPSEEK_MODEL_MAP } from './models.js';

export default {
  // OpenAI 格式处理器
  handleOpenAI: handleOpenAICompletion,

  // Claude 格式处理器
  handleClaude: handleDeepSeekClaude,

  // 原生格式处理器
  handleNative: handleDeepSeekCompletion,

  // 模型配置
  models: DEEPSEEK_MODEL_MAP,

  // 模型列表处理器
  handleModels: handleOpenAIModels,
  handleDeepSeekModels: handleDeepSeekModels,
};

// 同时导出命名导出以兼容旧代码
export {
  handleOpenAICompletion,
  handleDeepSeekClaude,
  handleDeepSeekCompletion,
  handleOpenAIModels,
  handleDeepSeekModels,
  DEEPSEEK_MODEL_MAP,
};
