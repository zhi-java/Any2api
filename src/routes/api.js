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
import { DEEPSEEK_MODEL_MAP, toOpenAIModel } from '../channels/deepseek/models.js';
import { normalizeRequestedModelName } from '../utils/response-utils.js';

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
  // 每个模型对象都带上上下文长度等元数据，供客户端自动识别能力。
  const deepseekModels = Object.keys(DEEPSEEK_MODEL_MAP).map(id => toOpenAIModel(id));

  res.json({
    object: 'list',
    data: deepseekModels
  });
});

// 单模型查询：部分客户端（及 OpenAI SDK 的 models.retrieve）会调用此端点，
// 用于读取上下文长度等能力。缺少它时这些客户端会报 404 或无法识别模型。
router.get('/models/:model', (req, res) => {
  const requested = decodeURIComponent(String(req.params.model || ''));
  const normalized = normalizeRequestedModelName(requested);
  if (!Object.prototype.hasOwnProperty.call(DEEPSEEK_MODEL_MAP, normalized)) {
    return res.status(404).json({
      error: {
        message: `The model '${requested}' does not exist`,
        type: 'invalid_request_error',
        code: 'model_not_found',
        param: 'model',
      },
    });
  }
  res.json(toOpenAIModel(normalized));
});

export default router;
