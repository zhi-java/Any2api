/**
 * Claude API 格式适配器
 *
 * 将 Claude API 格式 ↔ OpenAI API 格式相互转换
 * 支持流式和非流式两种模式
 */

// ============================================================
// 工具函数
// ============================================================

/**
 * 提取文本内容（支持字符串或 content 数组）
 */
function extractText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (part.type === 'text') return part.text || '';
        if (part.type === 'image') return '[Image]';
        return '';
      })
      .filter(Boolean)
      .join('\n');
  }
  return '';
}

/**
 * 映射 finish_reason
 */
function mapFinishReason(openaiReason) {
  const mapping = {
    stop: 'end_turn',
    tool_calls: 'tool_use',
    length: 'max_tokens',
    content_filter: 'end_turn',
  };
  return mapping[openaiReason] || 'end_turn';
}

/**
 * 映射 stop_reason 到 finish_reason
 */
function mapStopReasonToFinish(claudeReason) {
  const mapping = {
    end_turn: 'stop',
    tool_use: 'tool_calls',
    max_tokens: 'length',
  };
  return mapping[claudeReason] || 'stop';
}

// ============================================================
// 请求格式转换：Claude → OpenAI
// ============================================================

/**
 * 将 Claude messages 转换为 OpenAI messages
 */
function convertClaudeMessages(claudeMessages, systemPrompt) {
  const openaiMessages = [];

  // 添加 system 消息（如果有）
  if (systemPrompt) {
    openaiMessages.push({
      role: 'system',
      content: systemPrompt,
    });
  }

  for (const msg of claudeMessages) {
    if (msg.role === 'user') {
      // 处理 user 消息
      const content = [];

      if (typeof msg.content === 'string') {
        content.push({ type: 'text', text: msg.content });
      } else if (Array.isArray(msg.content)) {
        for (const part of msg.content) {
          if (part.type === 'text') {
            content.push({ type: 'text', text: part.text });
          } else if (part.type === 'image') {
            // Claude 图片格式 → OpenAI 图片格式
            content.push({
              type: 'image_url',
              image_url: {
                url: part.source?.type === 'base64'
                  ? `data:${part.source.media_type};base64,${part.source.data}`
                  : part.source?.url || '',
              },
            });
          } else if (part.type === 'tool_result') {
            // 工具结果：转换为独立的 tool 消息（稍后处理）
            // 暂时跳过，后面统一处理
          }
        }
      }

      // 检查是否有 tool_result
      const toolResults = Array.isArray(msg.content)
        ? msg.content.filter((p) => p.type === 'tool_result')
        : [];

      if (toolResults.length > 0) {
        // 先添加文本内容（如果有）
        const textContent = content.filter((c) => c.type === 'text' || c.type === 'image_url');
        if (textContent.length > 0) {
          openaiMessages.push({
            role: 'user',
            content: textContent.length === 1 && textContent[0].type === 'text'
              ? textContent[0].text
              : textContent,
          });
        }

        // 添加工具结果
        for (const result of toolResults) {
          openaiMessages.push({
            role: 'tool',
            tool_call_id: result.tool_use_id,
            content: typeof result.content === 'string'
              ? result.content
              : JSON.stringify(result.content),
          });
        }
      } else {
        // 普通 user 消息
        openaiMessages.push({
          role: 'user',
          content: content.length === 1 && content[0].type === 'text'
            ? content[0].text
            : (content.length > 0 ? content : ''),
        });
      }
    } else if (msg.role === 'assistant') {
      // 处理 assistant 消息
      let textContent = '';
      const toolCalls = [];

      if (typeof msg.content === 'string') {
        textContent = msg.content;
      } else if (Array.isArray(msg.content)) {
        for (const part of msg.content) {
          if (part.type === 'text') {
            textContent += part.text;
          } else if (part.type === 'tool_use') {
            // Claude tool_use → OpenAI tool_calls
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

      const assistantMsg = {
        role: 'assistant',
        content: textContent || null,
      };

      if (toolCalls.length > 0) {
        assistantMsg.tool_calls = toolCalls;
      }

      openaiMessages.push(assistantMsg);
    }
  }

  return openaiMessages;
}

/**
 * 将 Claude tools 转换为 OpenAI tools
 */
function convertClaudeTools(claudeTools) {
  if (!Array.isArray(claudeTools)) return [];

  return claudeTools.map((tool) => ({
    type: 'function',
    function: {
      name: tool.name,
      description: tool.description || '',
      parameters: tool.input_schema || { type: 'object', properties: {} },
    },
  }));
}

/**
 * 将 Claude 请求转换为 OpenAI 格式
 */
export function convertClaudeRequest(claudeReq) {
  if (!claudeReq) {
    throw new Error('Invalid Claude request: request body is required');
  }

  if (!Array.isArray(claudeReq.messages) || claudeReq.messages.length === 0) {
    throw new Error('Invalid Claude request: messages array is required and must not be empty');
  }

  const {
    messages,
    system,
    max_tokens,
    temperature,
    top_p,
    tools,
    stream,
    model,
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
 */
export function convertOpenAIResponse(openaiResp, model) {
  if (!openaiResp || !Array.isArray(openaiResp.choices) || openaiResp.choices.length === 0) {
    throw new Error('Invalid OpenAI response: missing choices array');
  }

  const choice = openaiResp.choices[0];
  if (!choice || !choice.message) {
    throw new Error('Invalid OpenAI response: missing message in choice');
  }

  const message = choice.message;

  // 构建 content 数组
  const content = [];

  if (message.content) {
    content.push({
      type: 'text',
      text: message.content,
    });
  }

  if (message.tool_calls && message.tool_calls.length > 0) {
    for (const tc of message.tool_calls) {
      let input = {};
      try {
        input = JSON.parse(tc.function.arguments);
      } catch {
        input = { raw: tc.function.arguments };
      }

      content.push({
        type: 'tool_use',
        id: tc.id.replace('call_', 'toolu_'),
        name: tc.function.name,
        input,
      });
    }
  }

  return {
    id: openaiResp.id.replace('chatcmpl-', 'msg_'),
    type: 'message',
    role: 'assistant',
    content,
    model: model || openaiResp.model,
    stop_reason: mapFinishReason(choice.finish_reason),
    stop_sequence: null,
    usage: {
      input_tokens: openaiResp.usage?.prompt_tokens || 0,
      output_tokens: openaiResp.usage?.completion_tokens || 0,
    },
  };
}

// ============================================================
// 响应格式转换：OpenAI → Claude（流式）
// ============================================================

/**
 * 解析 OpenAI SSE 流
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

        const jsonStr = trimmed.slice(6);
        try {
          const parsed = JSON.parse(jsonStr);
          yield parsed;
        } catch {
          // 忽略解析错误
        }
      }
    }
  } finally {
    reader.releaseLock();
  }
}

/**
 * 将 OpenAI 流式响应转换为 Claude SSE 事件流
 */
export async function* streamOpenAIToClaude(openaiStream, model) {
  const messageId = `msg_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;

  // 1. 发送 message_start 事件
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

  let contentBlockIndex = 0;
  let currentBlockType = null;
  let toolCallsBuffer = {}; // { index: { id, name, arguments } }
  let hasContent = false;
  let outputTokens = 0;

  for await (const chunk of parseOpenAIStream(openaiStream)) {
    const delta = chunk.choices?.[0]?.delta;
    const finishReason = chunk.choices?.[0]?.finish_reason;

    // 处理文本内容
    if (delta?.content) {
      if (currentBlockType !== 'text') {
        // 开始新的文本块
        yield {
          type: 'content_block_start',
          index: contentBlockIndex,
          content_block: { type: 'text', text: '' },
        };
        currentBlockType = 'text';
        hasContent = true;
      }

      // 发送文本增量
      yield {
        type: 'content_block_delta',
        index: contentBlockIndex,
        delta: { type: 'text_delta', text: delta.content },
      };
    }

    // 处理工具调用
    if (delta?.tool_calls) {
      for (const tc of delta.tool_calls) {
        const tcIndex = tc.index;

        if (!toolCallsBuffer[tcIndex]) {
          // 开始新的工具调用块
          if (currentBlockType === 'text') {
            // 结束之前的文本块
            yield {
              type: 'content_block_stop',
              index: contentBlockIndex,
            };
            contentBlockIndex++;
          }

          toolCallsBuffer[tcIndex] = {
            id: tc.id,
            name: tc.function?.name || '',
            arguments: '',
          };

          yield {
            type: 'content_block_start',
            index: contentBlockIndex + tcIndex,
            content_block: {
              type: 'tool_use',
              id: tc.id.replace('call_', 'toolu_'),
              name: tc.function?.name || '',
            },
          };

          currentBlockType = 'tool_use';
          hasContent = true;
        }

        // 累积工具参数
        if (tc.function?.arguments) {
          toolCallsBuffer[tcIndex].arguments += tc.function.arguments;

          yield {
            type: 'content_block_delta',
            index: contentBlockIndex + tcIndex,
            delta: {
              type: 'input_json_delta',
              partial_json: tc.function.arguments,
            },
          };
        }
      }
    }

    // 处理结束
    if (finishReason) {
      // 结束当前内容块
      if (hasContent) {
        // 结束文本块（如果有）
        if (currentBlockType === 'text') {
          yield {
            type: 'content_block_stop',
            index: contentBlockIndex,
          };
        }

        // 结束所有工具调用块
        const toolCallIndices = Object.keys(toolCallsBuffer).map(Number);
        for (const tcIndex of toolCallIndices) {
          yield {
            type: 'content_block_stop',
            index: contentBlockIndex + tcIndex + (currentBlockType === 'text' ? 1 : 0),
          };
        }
      }

      // 发送 message_delta
      yield {
        type: 'message_delta',
        delta: {
          stop_reason: mapFinishReason(finishReason),
          stop_sequence: null,
        },
        usage: { output_tokens: outputTokens },
      };

      // 发送 message_stop
      yield {
        type: 'message_stop',
      };

      break;
    }

    // 累积 token 统计
    if (chunk.usage?.completion_tokens) {
      outputTokens = chunk.usage.completion_tokens;
    }
  }
}

/**
 * 将 Claude SSE 事件写入响应流
 */
export function writeClaudeSSE(res, event) {
  res.write(`event: ${event.type}\n`);
  res.write(`data: ${JSON.stringify(event)}\n\n`);

  // 立即刷新
  if (res.flush) res.flush();
  else if (res._flush) res._flush();
  const socket = res.socket || res._socket;
  if (socket && typeof socket.setNoDelay === 'function') socket.setNoDelay(true);
}
