/**
 * OpenAI 响应格式构建器
 *
 * 依据 OpenAI Chat Completions API 最新规范（2025-2026）构建标准响应。
 * 参考：https://platform.openai.com/docs/api-reference/chat/object
 *
 * 非流式响应格式：
 * {
 *   id, object: "chat.completion", created, model, system_fingerprint,
 *   choices: [{ index, message: { role, content, refusal, tool_calls }, finish_reason }],
 *   usage: { prompt_tokens, completion_tokens, total_tokens, ... }
 * }
 *
 * 流式响应格式：
 * {
 *   id, object: "chat.completion.chunk", created, model, system_fingerprint,
 *   choices: [{ index, delta: { role|content|tool_calls }, finish_reason }]
 * }
 */

import { toOpenAIToolCalls, parseToolCallsFromText, streamToolCallsIncremental, writeSSE, validateToolCallsPipeline, detectFailedToolParse, sanitizeToolArguments } from './response-utils.js';

const SYSTEM_FINGERPRINT = process.env.SYSTEM_FINGERPRINT || 'fp_any2api_v1';

// ============================================================
// 响应 ID 生成
// ============================================================

export function generateChatCompletionId() {
  return `chatcmpl-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

// ============================================================
// 非流式响应构建
// ============================================================

/**
 * 构建 OpenAI 非流式 chat.completion 响应
 *
 * @param {object} options
 * @param {string} options.id - 响应 ID
 * @param {string} options.model - 模型名称
 * @param {string} options.content - assistant 的文本内容
 * @param {Array} [options.toolCalls] - 已解析的工具调用数组 (OpenAI 格式)
 * @param {string} [options.reasoningContent] - 推理内容（用于 reasoning_content 扩展字段）
 * @param {number} [options.promptTokens=0] - 输入 token 数
 * @param {number} [options.completionTokens=0] - 输出 token 数
 * @param {number} [options.reasoningTokens=0] - 推理 token 数
 * @param {string} [options.finishReason] - 结束原因，默认 auto
 * @param {boolean} [options.mergeThinking=false] - 是否将推理合并到 content 中
 * @returns {object} OpenAI 格式响应
 */
export function buildOpenAIResponse({
  id,
  model,
  content = '',
  toolCalls = null,
  reasoningContent = '',
  promptTokens = 0,
  completionTokens = 0,
  reasoningTokens = 0,
  finishReason,
} = {}) {
  // 确定 finish_reason
  const finalFinishReason = finishReason || (toolCalls?.length ? 'tool_calls' : 'stop');

  // 构建 message
  const message = {
    role: 'assistant',
    content: content || null,
    refusal: null,
  };

  // 添加工具调用
  if (toolCalls?.length) {
    message.tool_calls = toolCalls;
  }

  // 添加 reasoning_content（标准 OpenAI 扩展字段）
  if (reasoningContent) {
    message.reasoning_content = reasoningContent;
  }

  return {
    id: id || generateChatCompletionId(),
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model,
    system_fingerprint: SYSTEM_FINGERPRINT,
    choices: [{
      index: 0,
      message,
      logprobs: null,
      finish_reason: finalFinishReason,
    }],
    usage: {
      prompt_tokens: promptTokens,
      completion_tokens: completionTokens,
      total_tokens: promptTokens + completionTokens,
      prompt_tokens_details: {
        cached_tokens: 0,
      },
      completion_tokens_details: {
        reasoning_tokens: reasoningTokens,
      },
    },
  };
}

/**
 * 从累计的文本内容中解析工具调用，并构建 OpenAI 非流式响应
 *
 * @param {object} options
 * @param {string} options.id - 响应 ID
 * @param {string} options.model - 模型名称
 * @param {string} options.fullContent - 累计的文本内容
 * @param {string} [options.fullThinking] - 累计的推理内容
 * @param {boolean} [options.toolCallingEnabled=false] - 是否启用工具调用解析
 * @param {number} [options.usage=0] - token 用量
 * @param {boolean} [options.mergeThinking=false] - 是否合并推理到 content
 * @returns {object} OpenAI 格式响应
 */
export function buildOpenAIResponseFromContent({
  id,
  model,
  fullContent = '',
  fullThinking = '',
  toolCallingEnabled = false,
  usage = 0,
  mergeThinking = false,
  definedTools = [],      // 缺口1+3: 传入定义的工具用于校验
  toolChoice = 'auto',    // 缺口1: tool_choice 约束
} = {}) {
  // 步骤1: 解析工具调用
  const parsedToolCalls = parseToolCallsFromText(fullContent);
  const rawToolCalls = parsedToolCalls?.toolCalls?.length ? parsedToolCalls.toolCalls : null;
  // 即便没有 toolCalls，也可能有剥离了标签后的 content（防死循环）
  const parsedContent = parsedToolCalls?.content || null;

  // 步骤2: 【缺口1+3+4】工具调用校验流水线
  const { toolCalls, warning } = validateToolCallsPipeline(rawToolCalls, toolChoice, definedTools);
  if (warning) console.warn(`[OpenAI response] ${warning}`);

  // 步骤3: 【缺口2】检测静默解析失败；已成功解析出工具调用时不报警。
  if (!toolCalls?.length) {
    const parseWarning = detectFailedToolParse(fullContent, toolCallingEnabled);
    if (parseWarning) console.warn(`[OpenAI response] ${parseWarning}`);
  }

  // 步骤4: 确定最终 content 和 finish_reason
  // 降级：当无工具调用、thinking 有内容时，用 thinking 作为回复文本
  const isThinkingFallback = !toolCalls?.length && parsedContent !== null && fullThinking;
  const content = isThinkingFallback ? fullThinking
    : (toolCalls?.length ? (parsedContent || null) : (parsedContent ?? fullContent));
  const finishReason = toolCalls?.length ? 'tool_calls' : 'stop';

  return buildOpenAIResponse({
    id,
    model,
    content,
    toolCalls,
    reasoningContent: fullThinking,
    promptTokens: 0,
    completionTokens: usage || Math.round((fullContent.length + fullThinking.length) / 4),
    reasoningTokens: Math.round(fullThinking.length / 4),
    finishReason,
  });
}

// ============================================================
// 流式响应辅助 - SSE 头部写入
// ============================================================

/**
 * 写入 OpenAI 流式响应头（包含 SSE 头）
 */
export function writeStreamingHeader(res, id, model) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no',
  });

  // 初始 chunk：role
  writeSSE(res, {
    id,
    object: 'chat.completion.chunk',
    created: Math.floor(Date.now() / 1000),
    model,
    system_fingerprint: SYSTEM_FINGERPRINT,
    choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }],
  });
}

/**
 * 写入流式内容 delta
 */
export function writeStreamingContent(res, id, model, content) {
  writeSSE(res, {
    id,
    object: 'chat.completion.chunk',
    created: Math.floor(Date.now() / 1000),
    model,
    system_fingerprint: SYSTEM_FINGERPRINT,
    choices: [{ index: 0, delta: { content }, finish_reason: null }],
  });
}

/**
 * 写入流式推理内容 delta（已禁用 — 不对外暴露思考过程）
 * 思考内容仅在内部用于降级兜底，不出现流式响应中
 */
export function writeStreamingReasoning(res, id, model, content) {
  writeSSE(res, {
    id,
    object: 'chat.completion.chunk',
    created: Math.floor(Date.now() / 1000),
    model,
    system_fingerprint: SYSTEM_FINGERPRINT,
    choices: [{ index: 0, delta: { reasoning_content: content }, finish_reason: null }],
  });
}

/**
 * 写入流式结束事件（finish_reason）
 */
export function writeStreamingFinish(res, id, model, finishReason = 'stop') {
  writeSSE(res, {
    id,
    object: 'chat.completion.chunk',
    created: Math.floor(Date.now() / 1000),
    model,
    system_fingerprint: SYSTEM_FINGERPRINT,
    choices: [{ index: 0, delta: {}, finish_reason: finishReason }],
  });
}

/**
 * 写入流式结束标记 [DONE]
 */
export function writeStreamingDone(res) {
  res.write('data: [DONE]\n\n');
}

// ============================================================
// 流式工具调用综合处理
// ============================================================

/**
 * 在流式结束时，从 contentBuffer 解析工具调用并写入 SSE 事件
 *
 * @param {object} res - Express 响应对象
 * @param {string} id - 请求 ID
 * @param {string} model - 模型名称
 * @param {string} contentBuffer - 累积的文本 buffer
 * @param {boolean} [writePrefixContent=true] - 是否将工具调用前的文本作为 content 输出
 * @param {Array} [definedTools=[]] - 定义的工具列表（用于缺口1+3+4校验）
 * @param {string|object} [toolChoice='auto'] - tool_choice 约束
 */
export function writeStreamingToolCalls(res, id, model, contentBuffer, writePrefixContent = true, definedTools = [], toolChoice = 'auto') {
  if (!contentBuffer) return;

  const parsed = parseToolCallsFromText(contentBuffer);

  // 防死循环：parse 返回了剥离后的 content（即便无 toolCalls）
  if (parsed && !parsed.toolCalls?.length && parsed.content != null) {
    if (parsed.content) writeStreamingContent(res, id, model, parsed.content);
    writeStreamingFinish(res, id, model, 'stop');
    return true;
  }

  if (!parsed?.toolCalls?.length) return false;

  // 【缺口1+3+4】工具调用校验流水线
  const { toolCalls, warning } = validateToolCallsPipeline(parsed.toolCalls, toolChoice, definedTools);
  if (warning) console.warn(`[Streaming] ${warning}`);

  // 校验后无合法工具调用 → 输出内容作为文本
  if (!toolCalls?.length) {
    if (parsed.content) {
      writeStreamingContent(res, id, model, parsed.content);
    }
    writeStreamingFinish(res, id, model, 'stop');
    return true;
  }

  // 工具调用前的文本
  if (writePrefixContent && parsed.content) {
    writeStreamingContent(res, id, model, parsed.content);
  }

  // 参数消毒后的增量输出
  const sanitized = sanitizeToolArguments(toolCalls);
  const writeOpts = {
    id,
    object: 'chat.completion.chunk',
    created: Math.floor(Date.now() / 1000),
    model,
    system_fingerprint: SYSTEM_FINGERPRINT,
  };
  streamToolCallsIncremental(res, writeOpts, sanitized);
  writeStreamingFinish(res, id, model, 'tool_calls');

  return true;
}

// ============================================================
// 错误响应构建
// ============================================================

/**
 * 构建 OpenAI 格式错误响应
 */
export function buildOpenAIErrorResponse(status, message, type = 'invalid_request_error', param = null, code = null) {
  const error = { message, type };
  if (param !== null) error.param = param;
  if (code !== null) error.code = code;
  return { error };
}

/**
 * 发送 OpenAI 格式错误响应
 */
export function sendOpenAIError(res, status, message, type = 'invalid_request_error', param = null, code = null) {
  return res.status(status).json(buildOpenAIErrorResponse(status, message, type, param, code));
}
