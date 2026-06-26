/**
 * 模型路由器
 *
 * 根据模型名称前缀路由到正确的渠道处理器
 * 自动剥离 [1m] 等客户端附加后缀（源自 Claude Code）
 *
 * 路由优先级：
 * 1. deepseek-* → DeepSeek 渠道
 * 2. glm-* / cogview-* → GLM 渠道
 * 3. NOTION_MODELS 精确匹配 → Notion 渠道
 * 4. 未知模型 → 抛出错误
 */

import { normalizeRequestedModelName } from './response-utils.js';

/**
 * 路由模型到正确的渠道
 * @param {string} modelName - 模型名称
 * @returns {{channel: string, model: string}} 渠道和模型信息
 * @throws {Error} 未知模型时抛出错误
 */
export function routeModel(modelName) {
  // 输入验证 + 归一化（剥离 [1m] 等）
  const normalized = normalizeRequestedModelName(modelName);
  if (!normalized) {
    throw new Error('模型名称是必需的');
  }

  // DeepSeek 模型（前缀匹配）
  if (normalized.startsWith('deepseek-')) {
    return { channel: 'deepseek', model: normalized };
  }

  // GLM 模型（前缀匹配）
  if (normalized.startsWith('glm-')) {
    return { channel: 'glm', model: normalized };
  }

  // 未知模型
  throw new Error(
    `未知模型: ${normalized}。可用模型: deepseek-v4-flash, deepseek-v4-pro, glm-5.2-flash, glm-5.2-pro`
  );
}
