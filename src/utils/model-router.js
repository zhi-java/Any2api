/**
 * 模型路由器
 *
 * 根据模型名称前缀路由到正确的渠道处理器
 */

/**
 * 路由模型到正确的渠道
 * @param {string} modelName - 模型名称
 * @returns {{channel: string, model: string}} 渠道和模型信息
 * @throws {Error} 未知模型时抛出错误
 */
export function routeModel(modelName) {
  // 输入验证
  if (!modelName || typeof modelName !== 'string') {
    throw new Error('模型名称是必需的');
  }

  // DeepSeek 模型
  if (modelName.startsWith('deepseek-')) {
    return { channel: 'deepseek', model: modelName };
  }

  // GLM 模型
  if (modelName.startsWith('glm-') || modelName.startsWith('cogview-')) {
    return { channel: 'glm', model: modelName };
  }

  // 未知模型
  throw new Error(`未知模型: ${modelName}。支持的模型: deepseek-*, glm-*, cogview-*`);
}
