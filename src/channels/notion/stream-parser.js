/**
 * Notion AI 渠道 — NDJSON 流解析器
 *
 * Notion 的 runInferenceTranscript 返回 application/x-ndjson 流，
 * 每行一个 JSON 对象。格式参考 Go 项目的 ndjsonStreamLine：
 *
 * {"type":"agent-inference","id":"...","value":[{"type":"text","content":"...","signature":"..."}]}
 * {"type":"agent-inference","id":"...","value":[{"type":"thinking","content":"...","signature":"..."}]}
 * {"type":"agent-inference","id":"...","finishedAt":1234567890,"value":[...]}
 * {"type":"patch","v":[{"o":"a","p":"/s/-","v":{...}}]}
 * {"type":"record-map","recordMap":{...}}
 */

/**
 * @typedef {Object} StreamEvent
 * @property {'content'|'thinking'|'done'|'error'} type
 * @property {string} [content]
 * @property {string} [message]
 * @property {string} [subType]
 */

/**
 * 解析 Notion NDJSON 流，产出统一事件
 *
 * @param {ReadableStream} body - fetch 返回的 ReadableStream
 * @yields {StreamEvent}
 */
export async function* parseNotionNDJSON(body) {
  const reader = body.getReader();
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
        if (!trimmed) continue;

        const event = parseLine(trimmed);
        if (event) yield event;
      }
    }

    // 检查缓冲区剩余
    if (buffer.trim()) {
      const event = parseLine(buffer.trim());
      if (event) yield event;
    }
  } finally {
    try { reader.releaseLock(); } catch {}
  }
}

/**
 * 解析一行 NDJSON
 * @param {string} line
 * @returns {StreamEvent|null}
 */
function parseLine(line) {
  /** @type {any} */
  let parsed;
  try {
    parsed = JSON.parse(line);
  } catch {
    return null;
  }

  if (!parsed || typeof parsed !== 'object') return null;

  // agent-inference 事件：携带 text/thinking 内容
  if (parsed.type === 'agent-inference') {
    const values = parsed.value;
    if (Array.isArray(values)) {
      for (const v of values) {
        if (v.type === 'text' && v.content) {
          return { type: 'content', content: v.content };
        }
        if ((v.type === 'thinking' || v.type === 'reasoning') && v.content) {
          return { type: 'thinking', content: v.content };
        }
      }
    }
    // 如果已完成但没有 content，可能是结束标记
    if (parsed.finishedAt != null) {
      return { type: 'done' };
    }
    return null;
  }

  // record-map 事件：最终记录，表示完成
  if (parsed.type === 'record-map') {
    return { type: 'done' };
  }

  // patch-start 事件：可能携带信任规则错误
  if (parsed.type === 'patch-start') {
    const s = parsed.data?.s;
    if (Array.isArray(s)) {
      for (const item of s) {
        if (item.type === 'error' && item.subType === 'trust-rule-denied') {
          return { type: 'error', message: item.message || 'AI inference is not allowed.', subType: 'trust-rule-denied' };
        }
        if (item.type === 'error') {
          return { type: 'error', message: item.message || 'Inference error' };
        }
      }
    }
    return null;
  }

  // patch 事件：内包含状态更新，跳过（实时内容已通过 agent-inference 发送）
  if (parsed.type === 'patch') {
    return null;
  }

  // error
  if (parsed.type === 'error') {
    return { type: 'error', message: parsed.message || 'Notion API error' };
  }

  return null;
}

/**
 * 以非流式方式消费整个 NDJSON 流，收集完整文本
 *
 * @param {ReadableStream} body
 * @returns {Promise<string>}
 */
export async function consumeNotionStream(body) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let fullContent = '';

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          const parsed = JSON.parse(trimmed);
          if (parsed.type === 'agent-inference' && Array.isArray(parsed.value)) {
            for (const v of parsed.value) {
              if (v.type === 'text' && v.content) {
                fullContent += v.content;
              }
            }
          }
        } catch {}
      }
    }
  } finally {
    try { reader.releaseLock(); } catch {}
  }

  return fullContent;
}