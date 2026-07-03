/**
 * Claude/Anthropic 响应格式构建器
 *
 * 依据 Anthropic Messages API 最新规范构建标准响应。
 * 参考：https://docs.anthropic.com/en/api/messages
 *
 * 非流式响应格式：
 * {
 *   id, type: "message", role: "assistant",
 *   content: [{ type: "text"|"tool_use", ... }],
 *   model, stop_reason, stop_sequence,
 *   usage: { input_tokens, output_tokens }
 * }
 *
 * 流式事件：
 *   message_start → content_block_start → content_block_delta (text_delta|input_json_delta)
 *   → content_block_stop → message_delta → message_stop
 */

import { writeClaudeSSE, flushSSE, toOpenAIToolCalls, parseToolCallsFromText, validateToolCallsPipeline, detectFailedToolParse } from './response-utils.js';

// ============================================================
// 常量映射
// ============================================================

/**
 * OpenAI finish_reason → Claude stop_reason 映射
 */
const FINISH_REASON_MAP = {
  stop: 'end_turn',
  tool_calls: 'tool_use',
  length: 'max_tokens',
  content_filter: 'end_turn',
};

/**
 * Claude stop_reason → OpenAI finish_reason 映射
 */
const STOP_REASON_MAP = {
  end_turn: 'stop',
  tool_use: 'tool_calls',
  max_tokens: 'length',
};

export function mapFinishReason(openaiReason) {
  return FINISH_REASON_MAP[openaiReason] || 'end_turn';
}

export function mapStopReason(stopReason) {
  return STOP_REASON_MAP[stopReason] || 'stop';
}

// ============================================================
// 响应 ID 生成
// ============================================================

export function generateMessageId() {
  return `msg_${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

// ============================================================
// 非流式响应构建
// ============================================================

/**
 * 构建 Claude 非流式 message 响应
 *
 * @param {object} options
 * @param {string} options.id - 响应 ID
 * @param {string} options.model - 模型名称
 * @param {string} [options.text] - 文本内容
 * @param {Array<{id:string, name:string, input:object}>} [options.toolUses] - 工具调用块
 * @param {string} [options.stopReason='end_turn'] - 停止原因
 * @param {number} [options.inputTokens=0] - 输入 token
 * @param {number} [options.outputTokens=0] - 输出 token
 * @returns {object} Claude 格式响应
 */
export function buildClaudeResponse({
  id,
  model,
  text = '',
  thinking = '',
  toolUses = [],
  stopReason = 'end_turn',
  inputTokens = 0,
  outputTokens = 0,
} = {}) {
  // 构建 content 块数组
  const content = [];

  if (thinking) {
    content.push({ type: 'thinking', thinking, signature: '' });
  }

  if (text) {
    content.push({ type: 'text', text });
  }

  if (Array.isArray(toolUses)) {
    for (const tu of toolUses) {
      content.push({
        type: 'tool_use',
        id: tu.id,
        name: tu.name,
        input: tu.input || {},
      });
    }
  }

  return {
    id: id || generateMessageId(),
    type: 'message',
    role: 'assistant',
    content,
    model,
    stop_reason: stopReason,
    stop_sequence: null,
    usage: {
      input_tokens: inputTokens,
      output_tokens: outputTokens,
    },
  };
}

/**
 * 将 OpenAI 格式的 tool_calls 转换为 Claude tool_use 块
 *
 * @param {Array} toolCalls - OpenAI 格式 tool_calls
 * @returns {Array<{id:string, name:string, input:object}>} Claude tool_use 块
 */
export function openAIToolCallsToClaude(toolCalls) {
  if (!Array.isArray(toolCalls) || !toolCalls.length) return [];

  return toolCalls.map((tc, i) => {
    let input = {};
    try {
      input = JSON.parse(tc.function.arguments);
    } catch {
      input = { raw: tc.function.arguments || '{}' };
    }
    return {
      id: tc.id?.startsWith('toolu_') ? tc.id : `toolu_${(Date.now().toString(36) + Math.random().toString(36).slice(2, 8))}`,
      name: tc.function.name,
      input,
    };
  });
}

/**
 * 从累积的文本内容中解析工具调用，并构建 Claude 响应
 */
export function buildClaudeResponseFromContent({
  id,
  model,
  fullContent = '',
  thinking = '',
  stopReason = 'end_turn',
  inputTokens = 0,
  outputTokens = 0,
  toolCallingEnabled = false,
  definedTools = [],      // 缺口1+3: 传入定义的工具用于校验
  toolChoice = 'auto',    // 缺口1: tool_choice 约束
} = {}) {
  // 步骤1: 解析工具调用
  const parsed = parseToolCallsFromText(fullContent);
  const rawToolCalls = parsed?.toolCalls?.length ? parsed.toolCalls : null;

  // 步骤2: 【缺口1+3+4】工具调用校验流水线
  const { toolCalls, warning } = validateToolCallsPipeline(rawToolCalls, toolChoice, definedTools);
  if (warning) console.warn(`[Claude response] ${warning}`);

  // 步骤3: 【缺口2】检测静默解析失败；已成功解析出工具调用时不报警。
  if (!toolCalls?.length) {
    const parseWarning = detectFailedToolParse(fullContent, toolCallingEnabled);
    if (parseWarning) console.warn(`[Claude response] ${parseWarning}`);
  }

  if (toolCalls?.length) {
    const text = parsed?.content || '';
    const toolUses = openAIToolCallsToClaude(toolCalls);
    return buildClaudeResponse({
      id, model, text, thinking, toolUses,
      stopReason: 'tool_use',
      inputTokens, outputTokens,
    });
  }

  // 使用剥离后的 content（防死循环：避免原始 <tool_calls> 标签泄漏）
  const text = (parsed?.content ?? fullContent) || '';

  return buildClaudeResponse({
    id, model, text, thinking, stopReason, inputTokens, outputTokens,
  });
}

// ============================================================
// 流式响应辅助
// ============================================================

/**
 * 写入 message_start 事件
 */
export function writeClaudeMessageStart(res, id, model, inputTokens = 0) {
  writeClaudeSSE(res, {
    type: 'message_start',
    message: {
      id: id || generateMessageId(),
      type: 'message',
      role: 'assistant',
      content: [],
      model,
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: inputTokens, output_tokens: 0 },
    },
  });
}

/**
 * 写入 content_block_start 事件（文本块）
 */
export function writeClaudeTextBlockStart(res, index) {
  writeClaudeSSE(res, {
    type: 'content_block_start',
    index,
    content_block: { type: 'text', text: '' },
  });
}

/**
 * 写入 Claude thinking content block start
 * Anthropic SSE: content_block_start { type: "thinking" }
 */
export function writeClaudeThinkingBlockStart(res, index) {
  writeClaudeSSE(res, {
    type: 'content_block_start',
    index,
    content_block: { type: 'thinking', thinking: '', signature: '' },
  });
}

/**
 * 写入 Claude thinking delta
 * Anthropic SSE: content_block_delta { type: "thinking_delta" }
 */
export function writeClaudeThinkingDelta(res, index, thinking) {
  writeClaudeSSE(res, {
    type: 'content_block_delta',
    index,
    delta: { type: 'thinking_delta', thinking },
  });
}

/**
 * 写入 Claude thinking signature delta
 * Anthropic SSE: content_block_delta { type: "signature_delta" }
 */
export function writeClaudeSignatureDelta(res, index, signature) {
  writeClaudeSSE(res, {
    type: 'content_block_delta',
    index,
    delta: { type: 'signature_delta', signature },
  });
}

/**
 * 写入 content_block_start 事件（工具使用块）
 */
export function writeClaudeToolUseBlockStart(res, index, id, name) {
  writeClaudeSSE(res, {
    type: 'content_block_start',
    index,
    content_block: { type: 'tool_use', id, name, input: {} },
  });
}

/**
 * 写入 text_delta
 */
export function writeClaudeTextDelta(res, index, text) {
  writeClaudeSSE(res, {
    type: 'content_block_delta',
    index,
    delta: { type: 'text_delta', text },
  });
}

/**
 * 写入 input_json_delta（用于工具调用参数流式输出）
 */
export function writeClaudeInputJsonDelta(res, index, partialJson) {
  writeClaudeSSE(res, {
    type: 'content_block_delta',
    index,
    delta: { type: 'input_json_delta', partial_json: partialJson },
  });
}

/**
 * 写入 content_block_stop 事件
 */
export function writeClaudeContentBlockStop(res, index) {
  writeClaudeSSE(res, {
    type: 'content_block_stop',
    index,
  });
}

/**
 * 写入 message_delta 事件
 */
export function writeClaudeMessageDelta(res, stopReason = 'end_turn', outputTokens = 0) {
  writeClaudeSSE(res, {
    type: 'message_delta',
    delta: { stop_reason: stopReason, stop_sequence: null },
    usage: { output_tokens: outputTokens },
  });
}

/**
 * 写入 message_stop 事件
 */
export function writeClaudeMessageStop(res) {
  writeClaudeSSE(res, { type: 'message_stop' });
}

// ============================================================
// 完整流式事件序列（简化 high-level API）
// ============================================================

/**
 * 在流式结束时，基于 contentBuffer 处理工具调用 + 写入结束事件
 *
 * @param {Array} [definedTools=[]] - 定义的工具列表（用于缺口1+3+4校验）
 * @param {string|object} [toolChoice='auto'] - tool_choice 约束
 * @returns {boolean} 是否写入了 tool_use 事件
 */
export function writeClaudeStreamEndFromContent(res, contentBuffer, blockIndex, outputTokens = 0, definedTools = [], toolChoice = 'auto') {
  if (!contentBuffer) {
    writeClaudeMessageDelta(res, 'end_turn', outputTokens);
    writeClaudeMessageStop(res);
    return false;
  }

  const parsed = parseToolCallsFromText(contentBuffer);
  let toolCalls = parsed?.toolCalls?.length ? parsed.toolCalls : null;

  // 【缺口1+3+4】工具调用校验流水线
  if (toolCalls) {
    const { toolCalls: validatedCalls, warning } = validateToolCallsPipeline(toolCalls, toolChoice, definedTools);
    if (warning) console.warn(`[Claude stream] ${warning}`);
    toolCalls = validatedCalls;
  }

  // 【缺口2】检测静默解析失败
  const parseWarning = detectFailedToolParse(contentBuffer, true);
  if (parseWarning) console.warn(`[Claude stream] ${parseWarning}`);

  if (toolCalls?.length) {
    // 先输出工具调用前的文本
    if (parsed?.content) {
      writeClaudeTextBlockStart(res, blockIndex);
      writeClaudeTextDelta(res, blockIndex, parsed.content);
      writeClaudeContentBlockStop(res, blockIndex);
      blockIndex++;
    }

    // 输出每个 tool_use
    for (const tc of toolCalls) {
      const toolUseId = tc.id?.startsWith('toolu_') ? tc.id : `toolu_${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
      writeClaudeToolUseBlockStart(res, blockIndex, toolUseId, tc.function.name);

      // 增量输出参数
      const args = tc.function.arguments || '{}';
      const CHUNK_SIZE = 24;
      for (let j = 0; j < args.length; j += CHUNK_SIZE) {
        writeClaudeInputJsonDelta(res, blockIndex, args.slice(j, j + CHUNK_SIZE));
      }

      writeClaudeContentBlockStop(res, blockIndex);
      blockIndex++;
    }

    writeClaudeMessageDelta(res, 'tool_use', outputTokens);
  } else {
    // 纯文本输出（使用剥离后的 content，防死循环泄漏）
    const text = parsed?.content ?? contentBuffer;
    writeClaudeTextBlockStart(res, blockIndex);
    writeClaudeTextDelta(res, blockIndex, text);
    writeClaudeContentBlockStop(res, blockIndex);
    writeClaudeMessageDelta(res, 'end_turn', outputTokens);
  }

  writeClaudeMessageStop(res);
  return true;
}

// ============================================================
// 错误响应构建
// ============================================================

/**
 * 构建 Claude 格式错误响应
 */
export function buildClaudeErrorResponse(message, type = 'invalid_request_error') {
  return {
    type: 'error',
    error: { type, message },
  };
}

/**
 * 发送 Claude 格式错误响应
 */
export function sendClaudeError(res, status, message, type = 'invalid_request_error') {
  return res.status(status).json(buildClaudeErrorResponse(message, type));
}
