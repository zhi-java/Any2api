/**
 * Notion AI 渠道 — NDJSON 流解析器
 *
 * Notion 的 runInferenceTranscript 返回 application/x-ndjson 流，
 * 每行一个 JSON 对象。主流格式使用 patch 操作逐步构建推理内容。
 *
 * 关键修复：Notion 的 agent-inference 步骤中，value[0] 是 thinking 类型（推理过程），
 * value[1+] 是 text 类型（最终回答）。解析器通过跟踪每个步骤中各 value index 的类型，
 * 正确区分 thinking（→ reasoning_content）和 text（→ content）。
 */

/**
 * @typedef {Object} StreamEvent
 * @property {'content'|'thinking'|'done'|'error'} type
 * @property {string} [content]
 * @property {string} [message]
 * @property {string} [subType]
 */

/** 跟踪每个 step 中 thinking/reasoning 的 value index */
let _thinkingValueIndices = new Map();
let _stepCounter = 0;

function _getStepIdx(path) {
  if (!path) return -1;
  const m = path.match(/^\/s\/(\d+)/);
  return m ? parseInt(m[1], 10) : -1;
}
function _getValueIdx(path) {
  if (!path) return -1;
  const m = path.match(/\/value\/(\d+)(?:\/|$)/);
  return m ? parseInt(m[1], 10) : -1;
}

/**
 * 解析 Notion NDJSON 流，产出统一事件
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
        const events = parseLine(trimmed);
        if (events) {
          for (const event of (Array.isArray(events) ? events : [events])) {
            if (event) yield event;
          }
        }
      }
    }
    if (buffer.trim()) {
      const events = parseLine(buffer.trim());
      if (events) {
        for (const event of (Array.isArray(events) ? events : [events])) {
          if (event) yield event;
        }
      }
    }
  } finally {
    try { reader.releaseLock(); } catch {}
  }
}

function isBinaryBlob(str) {
  if (typeof str !== 'string' || str.length < 30) return false;
  if (str.length > 50) return /^[A-Za-z0-9+/]*={0,2}$/.test(str);
  return false;
}

function isModelIdentifier(str) {
  if (!str || str.length > 50) return false;
  return /^(?:claude|gpt|gemini|grok|kimi|minimax|deepseek|glm|almond|apricot|avocado|galette|oatmeal|oval|gingerbread|oregon|otaheite|fireworks|vertex|anthropic)[-a-z0-9.]*$/.test(str);
}

function isValidContent(str) {
  if (!str || typeof str !== 'string') return false;
  if (isBinaryBlob(str)) return false;
  if (isModelIdentifier(str)) return false;
  return true;
}

/**
 * 判断 thinking 内容是否看起来像真正的推理。
 * Notion 的 value[0] 始终标记为 thinking 类型，但有时它只包含短数字或单个词，
 * 这些其实是最终输出的一部分，不应作为独立的 reasoning_content 发射。
 * 规则：
 * - 长度 <= 5 字符 → 太短，不是推理
 * - 不含任何语言字母 → 纯数字/符号，不是推理
 * - 含明确推理关键词（中英文）→ 是推理
 * - 长度 > 60 且含英文长句 → 是推理
 */
function isPlausibleReasoning(text) {
  if (!text || text.length <= 5) return false;
  // 必须有英文字母或中文字符（排除纯数字/符号）
  const hasEnglish = /[A-Za-z]/.test(text);
  const hasChinese = /[一-鿿]/.test(text);
  if (!hasEnglish && !hasChinese) return false;

  // 英文推理关键词检测
  if (hasEnglish) {
    if (/(?:compare|calculate|analyze|determine|figure|think|reason|step|check|verify|evaluate|identify|consider|need to|should|let me|this is|the user|im going|i will|i can|approach|method|way to|how to|why|because|result|conclusion|answer|explain|understand|break down|look at)/i.test(text)) return true;
    // 长文本且含英文句式
    if (text.length > 60 && /[A-Z][a-z]{2,}\s+\w{2,}/.test(text)) return true;
    // 以 I/We/Let/First/The 开头的英文句子
    if (/^(I|We|Let|First|The|This|My|Our|Your|In|To|For|As|When|If|After|Before|Using|Based)\b/i.test(text.trim())) return true;
  }

  // 中文推理关键词检测
  if (hasChinese) {
    if (/(?:分析|计算|检查|验证|判断|比较|确定|考虑|我需要|我想|让我|首先|然后|步骤|方法|思路|原因|因为|所以|结论|回答|解释|理解|拆解|查看|查找|搜索|评估|识别|确认|确保|根据|基于|总结|归纳|推理|思考|规划|计划|分解|对比|区分|筛选|过滤|统计|测量|估算|预测|推断|猜测|假设|猜想|论证|证明|推导|追溯|追踪|定位|聚焦|关注|探讨|讨论|反思|回顾|梳理|整理|归类|排序|排列|组合|拆分|合并|映射|转换|变换|代入|替换|模拟|仿真)/.test(text)) return true;
    // 长文本含中文句式（"的"是中文最常用字，长句含"的"表明是自然语言推理）
    if (text.length > 60 && /[的提出了进行了通过对于关于在从到与和或以及]/.test(text)) return true;
  }

  return false;
}

function extractFromAgentValues(values) {
  const events = [];
  if (!Array.isArray(values)) return events;
  for (const v of values) {
    if (v.type === 'text' && isValidContent(v.content)) {
      // 兜底：当 API 未正确标记 type 时，用 isPlausibleReasoning 检测
      // 避免思考内容被误判为正文（Bug #1 修复）
      if (v.content.length > 5 && isPlausibleReasoning(v.content)) {
        events.push({ type: 'thinking', content: v.content });
      } else {
        events.push({ type: 'content', content: v.content });
      }
    }
    if ((v.type === 'thinking' || v.type === 'reasoning') && v.content && typeof v.content === 'string' && v.content.trim()) {
      events.push({ type: 'thinking', content: v.content });
    }
  }
  return events;
}

function extractStepContent(step) {
  if (!step || typeof step !== 'object') return [];
  if (step.type === 'agent-inference') {
    const value = step.value;
    if (Array.isArray(value)) return extractFromAgentValues(value);
    if (value && typeof value === 'object' && Array.isArray(value.value)) {
      return extractFromAgentValues(value.value);
    }
  }
  return [];
}

function extractValueContent(v) {
  const events = [];
  if (v == null) return events;
  if (typeof v === 'object' && !Array.isArray(v) && v.content && typeof v.content === 'string') {
    if (v.type === 'text' && isValidContent(v.content)) {
      // 兜底：text 类型的内容看起来像推理 → 作为 thinking 发射
      if (v.content.length > 5 && isPlausibleReasoning(v.content)) {
        events.push({ type: 'thinking', content: v.content }); return events;
      }
      events.push({ type: 'content', content: v.content }); return events;
    }
    if ((v.type === 'thinking' || v.type === 'reasoning') && v.content.trim()) {
      events.push({ type: 'thinking', content: v.content }); return events;
    }
    if (!v.type && isValidContent(v.content)) {
      // 无 type 标记时也用 isPlausibleReasoning 兜底
      if (v.content.length > 5 && isPlausibleReasoning(v.content)) {
        events.push({ type: 'thinking', content: v.content }); return events;
      }
      events.push({ type: 'content', content: v.content }); return events;
    }
  }
  return events;
}

/**
 * 解析一行 NDJSON，可能产出多个事件
 * @param {string} line
 * @returns {StreamEvent|StreamEvent[]|null}
 */
export function parseLine(line) {
  /** @type {any} */
  let parsed;
  try { parsed = JSON.parse(line); } catch { return null; }
  if (!parsed || typeof parsed !== 'object') return null;

  // ============ agent-inference 事件 ============
  if (parsed.type === 'agent-inference') {
    const events = extractFromAgentValues(parsed.value);
    if (events.length > 0) return events;
    if (parsed.finishedAt != null) return { type: 'done' };
    return null;
  }

  // ============ patch 事件 ============
  if (parsed.type === 'patch') {
    const ops = parsed.v;
    if (!Array.isArray(ops)) return null;
    const events = [];

    for (const op of ops) {
      const v = op.v;
      if (v == null) continue;
      const stepIdx = _getStepIdx(op.p);
      const valueIdx = _getValueIdx(op.p);
      const isValueDash = typeof op.p === 'string' && op.p.endsWith('/value/-');

      // 1) 创建 agent-inference 步骤（初始 value 数组）
      // {"o":"a","p":"/s/-","v":{"type":"agent-inference","value":[{...},...]}}
      // 注意：只追踪 thinking index，不发射任何 content——初始 value 中的 content
      // 会通过后续的 o=x delta 增量更新再次到达，如果在初始阶段就发射，
      // 会导致内容重复（Bug #2）。
      if (typeof v === 'object' && v.type === 'agent-inference' && Array.isArray(v.value)) {
        const sid = stepIdx >= 0 ? stepIdx : _stepCounter;
        _stepCounter = Math.max(_stepCounter, sid + 1);
        if (!_thinkingValueIndices.has(sid)) _thinkingValueIndices.set(sid, new Set());
        const ti = _thinkingValueIndices.get(sid);
        for (let vi = 0; vi < v.value.length; vi++) {
          const entry = v.value[vi];
          if (entry.type === 'thinking' || entry.type === 'reasoning') {
            ti.add(vi);
          }
          // 不发射 content！等待 o=x delta 更新
        }
        continue;
      }

      // 2) 追加新 value 条目到现有步骤
      // {"o":"a","p":"/s/6/value/-","v":{"type":"text","content":"..."}}
      if (op.o === 'a' && isValueDash) {
        if (!_thinkingValueIndices.has(stepIdx)) _thinkingValueIndices.set(stepIdx, new Set());
        const ti = _thinkingValueIndices.get(stepIdx);
        if (typeof v === 'object' && (v.type === 'thinking' || v.type === 'reasoning')) {
          ti.add(ti.size);
          // 不发射 thinking！等待 o=x delta
        } else if (typeof v === 'object' && v.type === 'text' && isValidContent(v.content)) {
          // 兜底：text 类型的内容看起来像推理 → 作为 thinking 追踪，等待 o=x delta
          if (v.content.length > 5 && isPlausibleReasoning(v.content)) {
            ti.add(ti.size);
          } else {
            events.push({ type: 'content', content: v.content });
          }
        }
        continue;
      }

      // 3) 按路径更新 thinking/text 内容
      // {"o":"x","p":"/s/6/value/0/content","v":"delta text"}
      if (typeof v === 'string' && v.trim() && (op.o === 'x' || op.o === 'p') &&
          typeof op.p === 'string' && op.p.endsWith('/content') && stepIdx >= 0 && valueIdx >= 0) {
        const ti = _thinkingValueIndices.get(stepIdx);
        if (ti && ti.has(valueIdx)) {
          // 只有内容看起来像真正的推理时才发射 thinking（Bug #1）
          // 过滤掉短文本（<=5字符的单个数字/词）、纯数字、无分析语义的文本
          // isPlausibleReasoning 已支持中英文推理关键词检测
          if (v.trim().length > 5 && isPlausibleReasoning(v)) {
            events.push({ type: 'thinking', content: v });
          } else {
            // 短 thinking 内容实际上是最终输出的一部分，作为 content 发射
            if (isValidContent(v)) events.push({ type: 'content', content: v });
          }
        } else if (isValidContent(v)) {
          events.push({ type: 'content', content: v });
        }
        continue;
      }

      // 4) 对象类型的 value（带 type 标签）
      if (typeof v === 'object' && (v.type === 'text' || v.type === 'thinking' || v.type === 'reasoning')) {
        if (v.type === 'text' && isValidContent(v.content)) {
          // 兜底：text 类型的内容看起来像推理 → 作为 thinking 发射
          if (v.content.length > 5 && isPlausibleReasoning(v.content)) {
            events.push({ type: 'thinking', content: v.content });
          } else {
            events.push({ type: 'content', content: v.content });
          }
        } else if ((v.type === 'thinking' || v.type === 'reasoning') && v.content) {
          events.push({ type: 'thinking', content: v.content });
        }
        continue;
      }

      // 5) 兜底：提取嵌套内容
      const extracted = extractValueContent(v);
      if (extracted.length > 0) events.push(...extracted);
    }

    if (events.length > 0) return events;
    return null;
  }

  // ============ patch-start 事件 ============
  if (parsed.type === 'patch-start') {
    const s = parsed.data?.s;
    if (Array.isArray(s)) {
      // 初始化 step 计数器：patch-start 中的 s 数组已占用前 N 个 step
      _stepCounter = Math.max(_stepCounter, s.length);
      for (const item of s) {
        if (item.type === 'error') {
          if (item.subType === 'trust-rule-denied') return { type: 'error', message: item.message || 'AI inference not allowed', subType: 'trust-rule-denied' };
          return { type: 'error', message: item.message || 'Inference error' };
        }
      }
    }
    return null;
  }

  // ============ record-map 事件 ============
  if (parsed.type === 'record-map') {
    const events = extractFromRecordMap(parsed.recordMap);
    if (events.length > 0) return events;
    return { type: 'done' };
  }

  // ============ done/success ============
  if (parsed.type === 'done' || parsed.type === 'success') return { type: 'done' };

  // ============ error ============
  if (parsed.type === 'error') return { type: 'error', message: parsed.message || 'Notion API error' };

  return null;
}

function extractFromRecordMap(recordMap) {
  const events = [];
  if (!recordMap || !recordMap.thread_message) return events;
  for (const [id, msg] of Object.entries(recordMap.thread_message)) {
    try {
      const value = msg.value?.value?.value || {};
      const step = value.step || {};
      if (step.type === 'agent-inference') {
        const stepValues = step.value?.value;
        if (Array.isArray(stepValues)) {
          for (const part of stepValues) {
            if (part.type === 'text' && part.content) events.push({ type: 'content', content: part.content });
            if ((part.type === 'thinking' || part.type === 'reasoning') && part.content) events.push({ type: 'thinking', content: part.content });
          }
        }
      }
    } catch {}
  }
  return events;
}

/**
 * 消费整个 NDJSON 流，收集完整文本
 */
export async function consumeNotionStream(body) {
  let fullContent = '';
  try {
    for await (const event of parseNotionNDJSON(body)) {
      if (event.type === 'content') fullContent += event.content;
      else if (event.type === 'error') throw new Error(event.message || 'Notion stream error');
    }
  } catch (err) {
    if (err.message && err.message.includes('Notion stream error')) throw err;
  }
  return fullContent;
}