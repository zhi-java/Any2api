/**
 * GLM SSE 流解析器
 *
 * 解析 GLM API 返回的 SSE 流，yield 统一事件
 */

/**
 * 解析 GLM API 返回的 SSE 流，yield 统一事件
 *
 * @param {ReadableStream} body
 * @yields {object} { type, content, toolCalls, imageUrl, finishReason, usage }
 */
export async function* parseGLMStream(body) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let accumulatedContent = '';

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        // 处理剩余 buffer
        const leftover = buffer.trim();
        if (leftover) {
          try {
            const parsed = JSON.parse(leftover);
            const result = parseGLMEvent(parsed, accumulatedContent);
            if (result) yield result;
          } catch { /* 忽略无法解析的剩余数据 */ }
        }
        break;
      }

      buffer += decoder.decode(value, { stream: true });

      // 尝试以换行符分割
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;

        // OpenAI 标准 SSE (data: {...})
        if (trimmed.startsWith('data:')) {
          const jsonStr = trimmed.slice(5).trim();
          if (!jsonStr || jsonStr === '[DONE]') {
            yield { type: 'done' };
            continue;
          }
          try {
            const parsed = JSON.parse(jsonStr);
            const result = parseGLMEvent(parsed, accumulatedContent);
            if (result) {
              // 累积 content 用于工具调用解析
              if (result.type === 'content') {
                accumulatedContent += result.content;
              }
              yield result;
            }
          } catch { /* 忽略无法解析的行 */ }
          continue;
        }

        // 尝试直接解析整行 JSON
        try {
          const parsed = JSON.parse(trimmed);
          const result = parseGLMEvent(parsed, accumulatedContent);
          if (result) {
            if (result.type === 'content') {
              accumulatedContent += result.content;
            }
            yield result;
          }
        } catch { /* 忽略无法解析的行 */ }
      }
    }
  } finally {
    reader.releaseLock();
  }
}

/**
 * 解析单个 GLM SSE 事件
 * 兼容多种可能的 GLM 响应格式
 */
function parseGLMEvent(parsed, accumulatedContent) {
  // 格式1: { choices: [{ delta: { content: "..." }, finish_reason: "stop" }] }
  if (Array.isArray(parsed.choices) && parsed.choices.length > 0) {
    const choice = parsed.choices[0];
    const delta = choice.delta || {};

    if (delta.content) {
      return { type: 'content', content: delta.content };
    }

    if (delta.tool_calls) {
      return { type: 'tool_calls', toolCalls: toOpenAIToolCalls(delta.tool_calls) };
    }

    if (choice.finish_reason) {
      return { type: 'done', finishReason: choice.finish_reason };
    }

    return null;
  }

  // 格式2: { event: "text", data: { content: "..." } } 或 { event: "finish", ... }
  if (parsed.event) {
    switch (parsed.event) {
      case 'text':
      case 'content':
      case 'message':
        return { type: 'content', content: parsed.data?.content || parsed.content || '' };
      case 'tool_calls':
        return { type: 'tool_calls', toolCalls: parsed.data?.tool_calls || parsed.tool_calls || [] };
      case 'image':
        return { type: 'image', imageUrl: parsed.data?.image_url || parsed.image_url || '' };
      case 'finish':
      case 'done':
        return { type: 'done', finishReason: parsed.data?.reason || 'stop' };
      case 'error':
        return { type: 'error', message: parsed.data?.message || parsed.message || 'Unknown error' };
      default:
        return null;
    }
  }

  // 格式3: DeepSeek 格式 { type: "content", content: "..." } / { type: "done" }
  if (parsed.type === 'content' || parsed.type === 'text') {
    return { type: 'content', content: parsed.content || parsed.text || '' };
  }
  if (parsed.type === 'thinking') {
    return { type: 'thinking', content: parsed.content || '' };
  }
  if (parsed.type === 'done' || parsed.type === 'finish') {
    return { type: 'done', finishReason: parsed.finish_reason || parsed.reason || 'stop' };
  }
  if (parsed.type === 'error') {
    return { type: 'error', message: parsed.message || 'Unknown error' };
  }

  // 格式4: { code: 200, data: { content: "...", status: "finish" } }
  if (parsed.code !== undefined && parsed.data) {
    if (parsed.data.content) {
      return { type: 'content', content: parsed.data.content };
    }
    if (parsed.data.status === 'finish' || parsed.data.status === 'done') {
      return { type: 'done', finishReason: parsed.data.reason || 'stop' };
    }
    if (parsed.data.tool_calls) {
      return { type: 'tool_calls', toolCalls: parsed.data.tool_calls };
    }
    if (parsed.data.image_url) {
      return { type: 'image', imageUrl: parsed.data.image_url };
    }
    return null;
  }

  // 格式5: 裸 content 字段
  if (typeof parsed.content === 'string' && parsed.content) {
    return { type: 'content', content: parsed.content };
  }

  // 格式6: 完成信号
  if (parsed.status === 'FINISHED' || parsed.status === 'finished' || parsed.status === 'done') {
    return { type: 'done', finishReason: 'stop' };
  }

  // 格式7: usage 信息
  if (parsed.usage || parsed.token_usage) {
    return { type: 'usage', usage: parsed.usage || parsed.token_usage };
  }

  return null;
}

// 工具调用辅助函数（从 client.js 引用）
function tryParseJson(value) {
  try { return JSON.parse(value); } catch { return null; }
}

function normalizeToolArguments(args) {
  if (args == null) return '{}';
  if (typeof args === 'string') {
    const trimmed = args.trim();
    if (!trimmed) return '{}';
    const parsed = tryParseJson(trimmed);
    return parsed === null ? trimmed : JSON.stringify(parsed);
  }
  try { return JSON.stringify(args); } catch { return '{}'; }
}

function toOpenAIToolCalls(calls) {
  return calls
    .map((call, index) => {
      const fn = call.function || call;
      const name = fn.name;
      if (!name || typeof name !== 'string') return null;
      return {
        id: call.id || `call_${Date.now().toString(36)}_${index}_${Math.random().toString(36).slice(2, 8)}`,
        type: 'function',
        function: {
          name,
          arguments: normalizeToolArguments(fn.arguments ?? call.arguments ?? {}),
        },
      };
    })
    .filter(Boolean);
}
