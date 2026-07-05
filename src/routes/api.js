/**
 * API 路由
 *
 * 处理所有 /v1/* 端点
 * - POST /v1/chat/completions (OpenAI 格式)
 * - POST /v1/messages (Claude 格式)
 * - POST /v1/responses (Responses 格式)
 * - GET /v1/models (模型列表)
 */

import express from 'express';
import { captureRawJsonPromptMetadata } from '../utils/response-utils.js';
import { createChatCompletionsRequestAdapter } from '../protocols/chat-completions/request-adapter.js';
import { renderChatCompletions, writeChatError } from '../protocols/chat-completions/renderer.js';
import { createClaudeMessagesRequestAdapter } from '../protocols/claude-messages/request-adapter.js';
import { renderClaudeMessages, writeClaudeProtocolError } from '../protocols/claude-messages/renderer.js';
import { createResponsesRequestAdapter } from '../protocols/responses/request-adapter.js';
import { renderResponses, writeResponsesError } from '../protocols/responses/renderer.js';
import { generateInternalEvents, prepareInternalGeneration } from '../core/generation.js';
import { DEEPSEEK_MODEL_MAP } from '../channels/deepseek/models.js';
import { GLM_MODEL_MAP } from '../channels/glm/index.js';
import { listQwenModels } from '../channels/qwen/index.js';
import { listKimiModels } from '../channels/kimi/index.js';

const router = express.Router();

/**
 * 强制流式中间件
 * 本项目所有模型只支持流式响应，拒绝非流式请求。
 * 无路径匹配，对经过此路由器的所有请求生效，手动按 req.path 分流。
 */
router.use((req, res, next) => {
  const isCompletion = req.path === '/chat/completions';
  const isMessages = req.path === '/messages';
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
    captureRawJsonPromptMetadata(req);
    const internalRequest = createChatCompletionsRequestAdapter(req);
    prepareInternalGeneration(internalRequest);
    const events = generateInternalEvents(internalRequest, { req, res });
    return await renderChatCompletions(res, events, {
      model: internalRequest.model.requested,
      stream: internalRequest.stream,
    });
  } catch (err) {
    return writeChatError(res, err);
  }
});

// ============= Claude 格式 - 统一端点（支持所有渠道） =============
router.post('/messages', async (req, res) => {
  try {
    captureRawJsonPromptMetadata(req);
    const internalRequest = createClaudeMessagesRequestAdapter(req);
    prepareInternalGeneration(internalRequest);
    const events = generateInternalEvents(internalRequest, { req, res });
    return await renderClaudeMessages(res, events, {
      model: internalRequest.model.requested,
      stream: internalRequest.stream,
    });
  } catch (err) {
    return writeClaudeProtocolError(res, err);
  }
});

// ============= Responses 格式 - Internal Event 端点 =============
router.post('/responses', async (req, res) => {
  try {
    captureRawJsonPromptMetadata(req);
    const internalRequest = createResponsesRequestAdapter(req);
    // Resolve model/channel before writing SSE headers so unsupported channels return a pre-stream error.
    prepareInternalGeneration(internalRequest);
    const events = generateInternalEvents(internalRequest, { req, res });
    return await renderResponses(res, events, {
      model: internalRequest.model.requested,
      stream: internalRequest.stream,
    });
  } catch (err) {
    return writeResponsesError(res, err);
  }
});

// ============= 模型列表 - 统一端点（所有渠道的模型） =============
router.get('/models', (req, res) => {
  // DeepSeek 模型
  const deepseekModels = Object.keys(DEEPSEEK_MODEL_MAP).map(id => ({
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

  // Qwen 模型（本地页面模型快照，不实时请求上游）
  const qwenModels = listQwenModels();

  // Kimi 模型（本地页面模型快照，不实时请求上游）
  const kimiModels = listKimiModels();

  // 合并
  res.json({
    object: 'list',
    data: [...deepseekModels, ...glmModels, ...qwenModels, ...kimiModels]
  });
});

export default router;
