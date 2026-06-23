/**
 * GLM 渠道统一入口
 *
 * 导出标准接口供主应用调用
 */

import { GLM_MODEL_MAP } from './models.js';
import { GlmTokenManager } from './token-manager.js';
import { handleGLMOpenAI, handleGLMClaude } from './handlers.js';

// ============================================================
// Token 管理器单例
// ============================================================

const tokenManager = new GlmTokenManager();

// ============================================================
// 导出标准接口
// ============================================================

/**
 * 导出模型配置（用于统一模型列表）
 */
export { GLM_MODEL_MAP };

/**
 * OpenAI 格式处理器
 * POST /v1/chat/completions
 */
export async function handleGLMCompletion(req, res) {
  return handleGLMOpenAI(req, res, tokenManager);
}

/**
 * Claude 格式处理器
 * POST /v1/messages
 */
export async function handleGLMClaudeMessages(req, res) {
  return handleGLMClaude(req, res, tokenManager);
}

/**
 * 模型列表处理器
 * GET /v1/models
 */
export function handleGLMModels(req, res) {
  const data = Object.keys(GLM_MODEL_MAP).map((id) => ({
    id,
    object: 'model',
    created: 1700000000,
    owned_by: 'zhipu',
  }));

  res.json({ object: 'list', data });
}
