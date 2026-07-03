/**
 * 模型路由器
 *
 * 根据模型名称路由到正确的渠道处理器
 * 自动剥离 [1m] 等客户端附加后缀（源自 Claude Code）
 *
 * 路由优先级：
 * 1. deepseek-* → DeepSeek 渠道
 * 2. GLM_MODEL_MAP 精确匹配 → GLM 渠道
 * 3. QWEN_MODEL_MAP 精确匹配 → Qwen 渠道
 * 4. KIMI_MODEL_MAP 精确匹配 → Kimi 渠道
 * 5. 未知模型 → 抛出错误
 */

import { GLM_MODEL_MAP } from '../channels/glm/models.js';
import { DEEPSEEK_MODEL_MAP } from '../channels/deepseek/models.js';
import { QWEN_MODEL_MAP } from '../channels/qwen/models.js';
import { KIMI_MODEL_MAP } from '../channels/kimi/models.js';
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

  // DeepSeek 模型（精确匹配公开模型表）
  if (Object.prototype.hasOwnProperty.call(DEEPSEEK_MODEL_MAP, normalized)) {
    return { channel: 'deepseek', model: normalized };
  }

  // GLM 模型（精确匹配公开模型表）
  if (Object.prototype.hasOwnProperty.call(GLM_MODEL_MAP, normalized)) {
    return { channel: 'glm', model: normalized };
  }

  // Qwen 模型（精确匹配公开模型表）
  if (Object.prototype.hasOwnProperty.call(QWEN_MODEL_MAP, normalized)) {
    return { channel: 'qwen', model: normalized };
  }

  // Kimi 模型（精确匹配公开模型表）
  if (Object.prototype.hasOwnProperty.call(KIMI_MODEL_MAP, normalized)) {
    return { channel: 'kimi', model: normalized };
  }

  // 未知模型
  throw new Error(
    `未知模型: ${normalized}。可用模型: deepseek-v4-flash, deepseek-v4-pro, glm-5.2, ${Object.keys(QWEN_MODEL_MAP).join(', ')}, ${Object.keys(KIMI_MODEL_MAP).join(', ')}`
  );
}
