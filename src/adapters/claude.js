/**
 * Claude API 格式适配器
 *
 * 将 Claude/Anthropic Messages API 格式 ↔ OpenAI Chat Completions API 格式相互转换。
 * 支持流式和非流式两种模式。
 *
 * 重构要点：
 * - 使用标准 response 构建工具
 * - 完善流式 tool_use input_json_delta 支持
 * - 正确的 content_block_start/stop 序列
 * - 修复 content block index 跟踪
 */

import { parseToolCallsFromText, textFromContent, writeClaudeSSE } from '../utils/response-utils.js';
import {
  buildClaudeResponse,
  buildClaudeResponseFromContent,
  generateMessageId,
  mapFinishReason,
  mapStopReason,
  openAIToolCallsToClaude,
  writeClaudeMessageStart,
  writeClaudeTextBlockStart,
  writeClaudeTextDelta,
  writeClaudeToolUseBlockStart,
  writeClaudeInputJsonDelta,
  writeClaudeContentBlockStop,
  writeClaudeMessageDelta,
  writeClaudeMessageStop,
  writeClaudeStreamEndFromContent,
} from '../utils/claude-response.js';

// ============================================================
// 请求格式转换：Claude → OpenAI
// ============================================================

/**
 * 将 Claude 消息转换为 OpenAI 格式
 */
function convertClaudeMessages(claudeMessages, systemPrompt) {
  const openaiMessages = [];

  if (systemPrompt) {
    openaiMessages.push({ role: 'system', content: textFromContent(systemPrompt) });
  }

  for (const msg of claudeMessages) {
    if (msg.role === 'user') {
      const { textParts, contentArray, toolResults, hasImages } = parseClaudeUserContent(msg.content);

      if (toolResults.length > 0) {
        // 文本和图片作为 user 消息
        if (textParts.length || hasImages) {
          openaiMessages.push({
            role: 'user',
            content: hasImages ? contentArray : (textParts.join('\n') || ''),
          });
        }
        // 工具结果作为单独 tool 消息
        for (const result of toolResults) {
          openaiMessages.push({
            role: 'tool',
            tool_call_id: result.tool_use_id,
            content: typeof result.content === 'string' ? result.content : JSON.stringify(result.content),
          });
        }
      } else {
        openaiMessages.push({
          role: 'user',
          content: hasImages ? contentArray : (textParts.join('\n') || ''),
        });
      }
    } else if (msg.role === 'assistant') {
      let textContent = '';
      const toolCalls = [];

      if (typeof msg.content === 'string') {
        textContent = msg.content;
      } else if (Array.isArray(msg.content)) {
        for (const part of msg.content) {
          if (part.type === 'text') textContent += part.text;
          else if (part.type === 'tool_use') {
            toolCalls.push({
              id: part.id,
              type: 'function',
              function: {
                name: part.name,
                arguments: JSON.stringify(part.input || {}),
              },
            });
          }
        }
      }

      const assistantMsg = { role: 'assistant', content: textContent || null };
      if (toolCalls.length) assistantMsg.tool_calls = toolCalls;
      openaiMessages.push(assistantMsg);
    }
  }

  return openaiMessages;
}

/**
 * 解析 Claude user 消息的 content 数组
 */
function parseClaudeUserContent(content) {
  const textParts = [];
  const contentArray = [];
  const toolResults = [];
  let hasImages = false;

  if (typeof content === 'string') {
    textParts.push(content);
    contentArray.push({ type: 'text', text: content });
    return { textParts, contentArray, toolResults, hasImages };
  }

  if (Array.isArray(content)) {
    for (const part of content) {
      if (part.type === 'text') {
        textParts.push(part.text);
        contentArray.push({ type: 'text', text: part.text });
      } else if (part.type === 'image') {
        hasImages = true;
        contentArray.push({
          type: 'image_url',
          image_url: {
            url: part.source?.type === 'base64'
              ? `data:${part.source.media_type};base64,${part.source.data}`
              : part.source?.url || '',
          },
        });
      } else if (part.type === 'tool_result') {
        toolResults.push(part);
      }
    }
  }

  return { textParts, contentArray, toolResults, hasImages };
}

/**
 * 将 Claude tools 转换为 OpenAI tools
 */
function convertClaudeTools(claudeTools) {
  if (!Array.isArray(claudeTools)) return [];
  return claudeTools.map(tool => ({
    type: 'function',
    function: {
      name: tool.name,
      description: tool.description || '',
      parameters: tool.input_schema || { type: 'object', properties: {} },
    },
  }));
}

/**
 * 将完整的 Claude 请求转换为 OpenAI 格式
 */
export function convertClaudeRequest(claudeReq) {
  if (!claudeReq) {
    throw new Error('Invalid Claude request: request body is required');
  }
  if (!Array.isArray(claudeReq.messages) || claudeReq.messages.length === 0) {
    throw new Error('Invalid Claude request: messages array is required and must not be empty');
  }

  const {
    messages, system, max_tokens, temperature, top_p, tools, stream, model,
  } = claudeReq;

  const openaiMessages = convertClaudeMessages(messages, system);
  const openaiTools = convertClaudeTools(tools);

  return {
    model: model || 'gpt-3.5-turbo',
    messages: openaiMessages,
    max_tokens,
    temperature,
    top_p,
    tools: openaiTools.length > 0 ? openaiTools : undefined,
    stream: stream ?? false,
  };
}

// ============================================================
// 响应格式转换：OpenAI → Claude（非流式）
// ============================================================

/**
 * 将 OpenAI 非流式响应转换为 Claude 格式
 *
 * @param {object} openaiResp - OpenAI 格式响应
 * @param {string} [model] - 模型名称
 * @returns {object} Claude 格式响应
 */
export function convertOpenAIResponse(openaiResp, model) {
  if (!openaiResp || !Array.isArray(openaiResp.choices) || !openaiResp.choices[0]) {
    throw new Error('Invalid OpenAI response: missing choices array');
  }

  const choice = openaiResp.choices[0];
  if (!choice || !choice.message) {
    throw new Error('Invalid OpenAI response: missing message in choice');
  }

  const message = choice.message;
  const text = message.content || '';
  const toolUses = openAIToolCallsToClaude(message.tool_calls);

  return buildClaudeResponse({
    id: generateMessageId(),
    model: model || openaiResp.model,
    text,
    toolUses,
    stopReason: mapFinishReason(choice.finish_reason),
    inputTokens: openaiResp.usage?.prompt_tokens || 0,
    outputTokens: openaiResp.usage?.completion_tokens || 0,
  });
}

// ============================================================
// 响应格式转换：OpenAI → Claude（流式）
// ============================================================

/**
 * 解析 OpenAI SSE 流（从 ReadableStream）
 */
async function* parseOpenAIStream(stream) {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || trimmed === 'data: [DONE]') continue;
        if (!trimmed.startsWith('data: ')) continue;

        try {
          const parsed = JSON.parse(trimmed.slice(6));
          yield parsed;
        } catch { /* 忽略解析错误 */ }
      }
    }
  } finally {
    reader.releaseLock();
  }
}

/**
 * 将 OpenAI 流式响应转换为 Claude SSE 事件序列
 *
 * 按 Anthropic 标准事件顺序输出：
 * message_start
 *   → content_block_start (text|tool_use)
 *     → content_block_delta (text_delta|input_json_delta)
 *   → content_block_stop
 * → message_delta
 * → message_stop
 */
export async function* streamOpenAIToClaude(openaiStream, model) {
  const messageId = generateMessageId();

  // 1. message_start
  yield {
    type: 'message_start',
    message: {
      id: messageId,
      type: 'message',
      role: 'assistant',
      content: [],
      model: model || 'unknown',
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: 0, output_tokens: 0 },
    },
  };

  let textBlockOpen = false;
  let toolCallBlockOpen = new Map(); // index → { id, name }
  let currentBlockIndex = 0;
  let outputTokens = 0;

  for await (const chunk of parseOpenAIStream(openaiStream)) {
    const delta = chunk.choices?.[0]?.delta;
    const finishReason = chunk.choices?.[0]?.finish_reason;

    // 处理文本 delta
    if (delta?.content) {
      if (!textBlockOpen && !toolCallBlockOpen.size) {
        // 尚无任何 block 打开，启动文本 block
        yield { type: 'content_block_start', index: currentBlockIndex, content_block: { type: 'text', text: '' } };
        textBlockOpen = true;
      }
      if (textBlockOpen) {
        yield { type: 'content_block_delta', index: currentBlockIndex, delta: { type: 'text_delta', text: delta.content } };
      }
    }

    // 处理工具调用 delta
    if (delta?.tool_calls) {
      for (const tc of delta.tool_calls) {
        const tcIndex = tc.index;

        if (!toolCallBlockOpen.has(tcIndex)) {
          // 关闭文本 block（如果有）
          if (textBlockOpen) {
            yield { type: 'content_block_stop', index: currentBlockIndex };
            textBlockOpen = false;
            currentBlockIndex++;
          }

          // 工具 ID 和名称在第一个块中出现
          const toolId = tc.id || `toolu_${Date.now().toString(36)}_${tcIndex}`;
          const toolName = tc.function?.name || '';

          toolCallBlockOpen.set(tcIndex, { id: toolId, name: toolName });

          yield {
            type: 'content_block_start',
            index: currentBlockIndex + tcIndex,
            content_block: { type: 'tool_use', id: toolId, name: toolName },
          };
        }

        // 参数增量
        if (tc.function?.arguments) {
          yield {
            type: 'content_block_delta',
            index: currentBlockIndex + tcIndex,
            delta: { type: 'input_json_delta', partial_json: tc.function.arguments },
          };
        }
      }
    }

    // 结束处理
    if (finishReason) {
      // 关闭所有打开的 block
      if (textBlockOpen) {
        yield { type: 'content_block_stop', index: currentBlockIndex };
        textBlockOpen = false;
      }

      for (const [index] of toolCallBlockOpen) {
        yield { type: 'content_block_stop', index: currentBlockIndex + index };
      }
      toolCallBlockOpen.clear();

      // message_delta
      yield {
        type: 'message_delta',
        delta: { stop_reason: mapFinishReason(finishReason), stop_sequence: null },
        usage: { output_tokens: outputTokens },
      };

      // message_stop
      yield { type: 'message_stop' };
      return;
    }

    // token 统计
    if (chunk.usage?.completion_tokens) {
      outputTokens = chunk.usage.completion_tokens;
    }
  }

  // 流意外结束的兜底
  if (textBlockOpen) {
    yield { type: 'content_block_stop', index: currentBlockIndex };
  }
  for (const [index] of toolCallBlockOpen) {
    yield { type: 'content_block_stop', index: currentBlockIndex + index };
  }
  yield {
    type: 'message_delta',
    delta: { stop_reason: 'end_turn', stop_sequence: null },
    usage: { output_tokens: outputTokens },
  };
  yield { type: 'message_stop' };
}

export { writeClaudeSSE };
