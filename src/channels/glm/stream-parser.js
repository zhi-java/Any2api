/**
 * GLM SSE 流解析器
 *
 * 解析 GLM API 返回的 SSE 流，yield 统一事件。
 * 自动处理：
 * - 完整快照 → 增量 delta 转换（GLM 网页版行为）
 * - <think>...</think> 提取为独立的 thinking 事件
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
  let accumulatedThinking = '';
  let lastRawContent = ''; // 完整快照去重
  let accumulatedDeltaContent = '';

  /**
   * 从完整文本中分离 <think>...</think> 推理部分
   * 返回 { thinking, text }
   * - thinking: 推理内容（可能为 null）
   * - text: 排除 thinking 标签后的纯文本
   */
  function splitThinking(text) {
    const match = text.match(/<think>([\s\S]*?)<\/think>/);
    if (match) {
      return {
        thinking: match[1].trim(),
        text: text.slice(match.index + match[0].length).trim(),
      };
    }
    // 标签未闭合（仍在思考中）
    const openMatch = text.match(/<think>([\s\S]*)$/);
    if (openMatch) {
      return { thinking: openMatch[1].trim(), text: '' };
    }
    return { thinking: null, text };
  }

  /**
   * 处理新收到的完整内容文本，生成增量事件数组
   *
   * GLM 网页版返回的是「完整内容快照」（每个事件含当前全部文本），
   * 这里提取增量并自动分离 thinking 与 content。
   *
   * @returns {Array|null} 事件数组，或 null（去重/无变化）
   */
  function processContent(newContent) {
    // 去重
    if (!newContent || newContent === lastRawContent) return null;
    lastRawContent = newContent;

    // 分离 thinking 和 text
    const { thinking, text } = splitThinking(newContent);
    const events = [];

    // --- 处理 thinking delta ---
    if (thinking !== null) {
      if (thinking !== accumulatedThinking) {
        const delta = accumulatedThinking
          ? thinking.slice(accumulatedThinking.length)
          : thinking;
        accumulatedThinking = thinking;
        if (delta) events.push({ type: 'thinking', content: delta });
      }
    }

    // --- 处理 content delta ---
    if (text) {
      // 快照模式：text 以 accumulatedContent 开头，取增量
      if (accumulatedContent && text.startsWith(accumulatedContent)) {
        const delta = text.slice(accumulatedContent.length);
        accumulatedContent = text;
        if (delta) events.push({ type: 'content', content: delta });
      } else if (text !== accumulatedContent) {
        const delta = accumulatedContent && text.startsWith(accumulatedContent)
          ? text.slice(accumulatedContent.length)
          : text;
        accumulatedContent = text;
        if (delta) events.push({ type: 'content', content: delta });
      }
    }

    return events.length ? events : null;
  }

  function processContentResult(result) {
    if (!result?.content) return null;
    if (result.snapshot !== false) return processContent(result.content);

    // OpenAI-style SSE content is already a delta. Accumulate it into a
    // synthetic full snapshot so the existing thinking splitter and snapshot
    // diff logic can be reused without dropping later chunks.
    accumulatedDeltaContent += result.content;
    return processContent(accumulatedDeltaContent);
  }

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        // 处理剩余 buffer
        const leftover = buffer.trim();
        if (leftover) {
          try {
            const parsed = JSON.parse(leftover);
            const result = parseGLMEvent(parsed);
            if (result) {
              if (result.type === 'content') {
                const events = processContentResult(result);
                if (events) {
                  for (const evt of events) yield evt;
                }
              } else {
                yield result;
              }
            }
          } catch { /* 忽略无法解析的剩余数据 */ }
        }
        // GLM 网页版格式：最后一条 SSE 事件可能同时包含内容+status:"finish"，
        // parseGLMEvent 优先返回 content 而不发射 done。
        // 因此 TCP 流结束时显式发射 done 确保 handler 收到结束信号。
        yield { type: 'done', finishReason: 'stop' };
        break;
      }

      buffer += decoder.decode(value, { stream: true });

      // 以换行符分割
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
            const result = parseGLMEvent(parsed);
            if (result) {
              // 处理 content 事件的增量 + thinking 提取
              if (result.type === 'content') {
                const events = processContentResult(result);
                if (events) {
                  for (const evt of events) yield evt;
                }
              } else {
                yield result;
              }
            }
          } catch { /* 忽略无法解析的行 */ }
          continue;
        }

        // 尝试直接解析整行 JSON
        try {
          const parsed = JSON.parse(trimmed);
          const result = parseGLMEvent(parsed);
          if (result) {
            if (result.type === 'content') {
              const events = processContentResult(result);
              if (events) {
                for (const evt of events) yield evt;
              }
            } else {
              yield result;
            }
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
function parseGLMEvent(parsed) {
  // 格式1: { choices: [{ delta: { content: "..." }, finish_reason: "stop" }] }
  if (Array.isArray(parsed.choices) && parsed.choices.length > 0) {
    const choice = parsed.choices[0];
    const delta = choice.delta || {};

    if (delta.content) {
      return { type: 'content', content: delta.content, snapshot: false };
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

  // 格式8: GLM 网页版格式 { parts: [{ content: [{ type, text, tool_calls }], status }] }
  if (Array.isArray(parsed.parts)) {
    // 空 parts 数组 → 会话初始化事件，跳过
    if (parsed.parts.length === 0) return null;

    let fullText = '';
    let hasToolCalls = false;
    let toolCalls = [];
    let sawInternalToolActivity = false;

    // Deep-research/search mode emits internal Web tool call/result parts with
    // status:"finish" before the final assistant text. Those are not API-level
    // completion markers; stopping there makes the channel return an empty body.
    // Scan all parts and only surface assistant text/tool calls intended for the
    // client, while ignoring GLM's own retrieve tool lifecycle events.
    for (const part of parsed.parts) {
      const items = Array.isArray(part?.content) ? part.content : (part?.content ? [part.content] : []);
      if (part?.role === 'tool') sawInternalToolActivity = true;

      for (const item of items) {
        if (item?.type === 'tool_calls' || item?.type === 'tool_result') {
          sawInternalToolActivity = true;
          continue;
        }

        if (item?.type === 'text' && item.text) {
          fullText += item.text;

          // 检查 tool_calls（空对象 {} 表示无工具调用）
          if (item.tool_calls && typeof item.tool_calls === 'object' && !Array.isArray(item.tool_calls)) {
            const tcKeys = Object.keys(item.tool_calls);
            if (tcKeys.length > 0) {
              const tcArray = item.tool_calls.tool_calls || item.tool_calls.calls || null;
              if (Array.isArray(tcArray) && tcArray.length > 0) {
                hasToolCalls = true;
                toolCalls = toOpenAIToolCalls(tcArray);
              }
            }
          }
        }
      }
    }

    if (fullText && hasToolCalls) {
      return { type: 'tool_calls', toolCalls };
    }
    if (fullText) {
      return { type: 'content', content: fullText };
    }

    // GLM internal tool events also use status:"finish"; do not convert them to
    // done or callers will break before the final answer arrives. Non-tool finish
    // markers remain safe to surface, and TCP close still emits a final done.
    if (!sawInternalToolActivity && parsed.parts.some(part => part?.status === 'finish' || part?.status === 'done')) {
      return { type: 'done', finishReason: 'stop' };
    }

    return null;
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

// 工具调用辅助函数
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
