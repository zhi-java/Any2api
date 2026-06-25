/**
 * API 路由
 *
 * 处理所有 /v1/* 端点
 * - POST /v1/chat/completions (OpenAI 格式)
 * - POST /v1/messages (Claude 格式)
 * - GET /v1/models (模型列表)
 */

import express from 'express';
import { routeModel } from '../utils/model-router.js';
import deepseek from '../channels/deepseek/index.js';
import { handleGLMCompletion, handleGLMClaudeMessages, GLM_MODEL_MAP } from '../channels/glm/index.js';
import notion from '../channels/notion/index.js';

const router = express.Router();

/**
 * 强制流式中间件
 * 本项目所有模型只支持流式响应，拒绝非流式请求。
 * 无路径匹配，对经过此路由器的所有请求生效，手动按 req.path 分流。
 */
router.use((req, res, next) => {
  const isCompletion = req.originalUrl?.endsWith('/chat/completions');
  const isMessages = req.originalUrl?.endsWith('/messages');
  if ((isCompletion || isMessages) && req.body) {
    if (req.body.stream === false) {
      return res.status(400).json(isMessages ? {
        type: 'error',
        error: {
          type: 'invalid_request_error',
          message: 'Non-streaming responses are not supported. Set stream=true or omit stream (defaults to true).'
        }
      } : {
        error: {
          message: 'Non-streaming responses are not supported. Set stream=true or omit stream (defaults to true).',
          type: 'invalid_request_error',
          code: 'stream_required'
        }
      });
    }
    // 强制启用流式
    req.body.stream = true;
  }
  next();
});

// ============= OpenAI 格式 - 统一端点（支持所有渠道） =============
router.post('/chat/completions', async (req, res) => {
  try {
    // 1. 路由模型到正确的渠道
    const { channel } = routeModel(req.body.model);

    // 2. 分发到对应处理器
    if (channel === 'deepseek') {
      return await deepseek.handleOpenAI(req, res);
    } else if (channel === 'glm') {
      return await handleGLMCompletion(req, res);
    } else if (channel === 'notion') {
      return await notion.handleOpenAI(req, res);
    }

  } catch (err) {
    // 3. 错误处理（OpenAI 格式）
    return res.status(400).json({
      error: {
        message: err.message,
        type: 'invalid_request_error',
        param: 'model',
        code: 'model_not_found'
      }
    });
  }
});

// ============= Claude 格式 - 统一端点（支持所有渠道） =============
router.post('/messages', async (req, res) => {
  try {
    // 1. 路由模型到正确的渠道
    const { channel } = routeModel(req.body.model);

    // 2. 分发到对应处理器
    if (channel === 'deepseek') {
      return await deepseek.handleClaude(req, res);
    } else if (channel === 'glm') {
      return await handleGLMClaudeMessages(req, res);
    } else if (channel === 'notion') {
      return await notion.handleClaude(req, res);
    }

  } catch (err) {
    // 3. 错误处理（Claude 格式）
    return res.status(400).json({
      type: 'error',
      error: {
        type: 'invalid_request_error',
        message: err.message
      }
    });
  }
});

// ============= 模型列表 - 统一端点（所有渠道的模型） =============
router.get('/models', (req, res) => {
  // DeepSeek 模型
  const deepseekModels = Object.keys(deepseek.models).map(id => ({
    id,
    object: 'model',
    created: 1718000000,
    owned_by: 'deepseek',
  }));

  // GLM 模型
  const glmModels = Object.keys(GLM_MODEL_MAP).map(id => ({
    id,
    object: 'model',
    created: 1718000000,
    owned_by: 'zhipu',
  }));

  // Notion 模型
  const notionModels = notion.models.map(id => ({
    id,
    object: 'model',
    created: 1718000000,
    owned_by: 'notion',
  }));

  // 合并
  res.json({
    object: 'list',
    data: [...deepseekModels, ...glmModels, ...notionModels]
  });
});

export default router;
