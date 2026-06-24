/**
 * 共享响应工具函数
 *
 * 提供 SSE 写入、文本提取、工具调用解析等跨渠道共享工具
 *
 * ============ 高可用设计要点 ============
 * 1. 安全写入：所有 res.write() 调用前检查 writableEnded
 * 2. 缓冲上限：contentBuffer 最大 256KB，超出后降级为实时输出
 * 3. 客户端断开：正确清理所有资源，避免未处理 rejection
 * 4. 工具解析鲁棒性：深度JSON提取 + XML提取 + 多形式兼容
 *
 * ============ Python 桥提升点 ============
 * 1. _extract_first_json_object: 深度计数提取嵌套JSON
 * 2. _extract_code_block: 提取code fence内内容
 * 3. normalizeRequestedModelName: 剥离[1m]后缀
 * 4. hasToolHistory: 从历史消息检测工具行为
 * 5. 分层异常 + 状态码传播
 */

// ============================================================
// 安全 SSE 写入
// ============================================================

function isWritable(res) {
  return res && !res.writableEnded && !res.destroyed;
}

export function flushSSE(res) {
  try {
    if (!isWritable(res)) return;
    if (res.flush) res.flush();
    else if (res._flush) res._flush();
    const socket = res.socket || res._socket;
    if (socket && typeof socket.setNoDelay === 'function') socket.setNoDelay(true);
  } catch { /* 静默 */ }
}

export function writeSSE(res, payload) {
  if (!isWritable(res)) return false;
  try {
    res.write(`data: ${JSON.stringify(payload)}\n\n`);
    flushSSE(res);
    return true;
  } catch { return false; }
}

export function writeClaudeSSE(res, event) {
  if (!isWritable(res)) return false;
  try {
    res.write(`event: ${event.type}\n`);
    res.write(`data: ${JSON.stringify(event)}\n\n`);
    flushSSE(res);
    return true;
  } catch { return false; }
}

export function safeEnd(res) {
  if (isWritable(res)) {
    try { res.end(); } catch { /* 忽略 */ }
  }
}

export function setTCPNoDelay(req) {
  const socket = req.socket || req.connection;
  if (socket && typeof socket.setNoDelay === 'function') socket.setNoDelay(true);
}

// ============================================================
// 客户端断开监听
// ============================================================

export function setupClientDisconnect(req, streamBody) {
  let clientGone = false;
  let cancelling = false;

  const onClose = async () => {
    clientGone = true;
    if (streamBody && !cancelling) {
      cancelling = true;
      try { await streamBody.cancel(); } catch { /* 静默 */ }
    }
  };

  req.on('close', onClose);

  const cleanup = () => {
    req.off('close', onClose);
  };

  return { clientGone, cleanup };
}

// ============================================================
// contentBuffer 安全上限
// ============================================================

const MAX_BUFFER_SIZE = 256 * 1024;

export function safeAppendToBuffer(buffer, content) {
  if (!content) return { buffer, truncated: false };
  if (buffer.length + content.length > MAX_BUFFER_SIZE) {
    const remaining = MAX_BUFFER_SIZE - buffer.length;
    if (remaining <= 0) return { buffer, truncated: true };
    return { buffer: buffer + content.slice(0, remaining), truncated: true };
  }
  return { buffer: buffer + content, truncated: false };
}

// ============================================================
// 文本内容提取
// ============================================================

export function textFromContent(content) {
  if (content == null) return '';
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.map(part => {
      if (part.type === 'text') return part.text || '';
      if (part.type === 'image_url') return '[Image]';
      if (part.type === 'image_source') return '[Image]';
      return JSON.stringify(part);
    }).filter(Boolean).join('\n');
  }
  return JSON.stringify(content);
}

// ============================================================
// Python桥提升1: 模型名称归一化
// ============================================================

/**
 * 归一化请求的模型名称
 * - 剥离 `[1m]` 后缀（Claude Code 附加的上下文窗口提示）
 * - 去除首尾空格
 *
 * 源自 python _normalize_requested_model_name
 */
export function normalizeRequestedModelName(value) {
  if (!value || typeof value !== 'string') return '';
  let normalized = value.trim();
  // Claude Code can append local context-window hints such as "[1m]".
  while (normalized.endsWith('[1m]')) {
    normalized = normalized.slice(0, -4).trimEnd();
  }
  return normalized;
}

// ============================================================
// 工具调用规范化（API 输出端点友好层）
// ============================================================

export function normalizeTools(tools) {
  if (!Array.isArray(tools)) return [];
  return tools
    .filter(tool => tool?.type === 'function' && tool.function?.name)
    .map(tool => ({
      type: 'function',
      function: {
        name: tool.function.name,
        description: tool.function.description || '',
        parameters: tool.function.parameters || { type: 'object', properties: {} },
      },
    }));
}

/**
 * 从 tools 构建工具调用指令文本（用于后端 text-prompt 模式）
 *
 * ============== 防幻觉 & 防破碎设计 ==============
 * 1. 允许文本先于工具调用输出（thinking 不会丢失）
 * 2. 提供完整的正例（含文本前缀）
 * 3. 提供反面示例（模型常见错误）
 * 4. 明确要求 tool_calls 为数组（空数组 = 无需工具）
 * 5. 禁止空的 <tool_calls> 标签（直接输出文本）
 * =============================================
 */
export function buildToolInstructions(tools, toolChoice = 'auto') {
  const normalized = normalizeTools(tools);
  if (!normalized.length || toolChoice === 'none') return '';

  let choiceInstruction = 'Use a tool only when it is helpful or required to answer correctly.';
  if (toolChoice === 'required') choiceInstruction = 'You must call at least one tool.';
  if (toolChoice?.function?.name) {
    const forcedName = toolChoice.function.name;
    if (normalized.some(t => t.function.name === forcedName)) {
      choiceInstruction = `You must call the function named ${forcedName}.`;
    }
  }

  const toolFormat = (process.env.TOOL_FORMAT || 'xml').toLowerCase();

  if (toolFormat === 'json') {
    return `\n\n[Tool calling instructions]
Available tools:
${JSON.stringify(normalized, null, 2)}

${choiceInstruction}

=== IMPORTANT ===
- When you answer WITHOUT calling tools: output PLAIN TEXT as normal, NO JSON wrapper.
- When you NEED to call tools: output raw JSON ONLY (no markdown fences).

=== When calling tools (JSON format) ===
{"assistant_response": "your thinking for the user", "tool_calls": [{"name": "func_name", "arguments": {...}}]}

Example — single tool:
{"assistant_response": "Let me look that up.", "tool_calls": [{"name": "get_weather", "arguments": {"city": "Beijing"}}]}

Example — multiple tools:
{"assistant_response": "Checking multiple sources.", "tool_calls": [{"name": "search", "arguments": {"q": "weather"}}, {"name": "get_time", "arguments": {"tz": "UTC"}}]}

=== WRONG patterns (NEVER do these) ===

❌ tool_calls as string:
{"tool_calls": "[{\\"name\\": \\"x\\"}]"}  ← MUST BE JSON array, not string

❌ Markdown fences around JSON:
\`\`\`json
{"tool_calls": [...]}
\`\`\`  ← NO FENCES, output raw JSON directly

❌ Empty/Wrapper JSON when no tool needed:
{"assistant_response": "ok", "tool_calls": []}  ← WRONG, just answer as PLAIN TEXT

❌ Calling non-existent tools:
{"tool_calls": [{"name": "fake_func", ...}]}  ← Only use tools from the list above

Rules:
- Default to PLAIN TEXT. Only use JSON format when calling tools.
- assistant_response must be a string with your thinking/response.
- tool_calls must be a JSON array. Never invent tool names.`;
  }

  // 默认 XML 格式
  return `\n\n[Tool calling instructions]
Available tools:
${JSON.stringify(normalized, null, 2)}

${choiceInstruction}

=== IMPORTANT ===
- DEFAULT: answer as PLAIN TEXT (just talk to the user normally).
- ONLY when calling tools: use <tool_calls> XML format at the end of your text.

=== When calling tools (XML format) ===
Your thinking here... <tool_calls>[{"name":"func_name","arguments":{...}}]</tool_calls>

Examples:
Let me check the project. <tool_calls>[{"name":"Glob","arguments":{"pattern":"*"}}]</tool_calls>
First checking then reading. <tool_calls>[{"name":"Glob","arguments":{"pattern":"*.js"}},{"name":"Read","arguments":{"path":"index.js"}}]</tool_calls>

=== WRONG patterns (NEVER do these) ===

❌ Empty/Wrapper XML when no tool needed:
<tool_calls></tool_calls>  ← If no tool needed, answer as PLAIN TEXT only

❌ Nested or empty tags:
<tool_calls>
<tool_calls></tool_calls>  ← WRONG, use text only when no tools

❌ Raw text inside tags:
<tool_calls>use glob tool</tool_calls>  ← Must be valid JSON array

❌ Calling non-existent tools:
<tool_calls>[{"name": "fake_func", ...}]</tool_calls>  ← Only use tools from list above

Rules:
- DEFAULT: answer as plain text, NO XML tags.
- Only add <tool_calls> when calling tools. Text before it is fine.
- Content inside <tool_calls> must be valid JSON array.
- Never invent tool names. Only use tools listed above.`;
}

/**
 * 【缺口8修复】构建持久化工具定义
 *
 * 当请求中没有显式 tools 参数，但对话历史中有工具调用记录时，
 * 重新注入工具定义到 system prompt，防止模型在后续轮次「忘记」
 * 还能调用工具。
 *
 * @param {Array} messages - 消息列表
 * @param {Array} tools - 当前请求的 tools
 * @param {Array} knownToolDefs - 从历史中持久化的工具定义缓存
 * @returns {string} 持久化工具指令（如有必要）
 */
export function buildPersistentToolDefs(messages, tools, knownToolDefs = []) {
  if (Array.isArray(tools) && tools.length > 0) return '';
  if (!hasToolHistory(messages)) return '';
  if (knownToolDefs.length > 0) {
    return `\n\n[Persistent tool definitions — these tools are still available if needed]:\n${JSON.stringify(knownToolDefs, null, 2)}\n\nYou may still use these tools by outputting <tool_calls>...</tool_calls> as instructed earlier.`;
  }
  return '';
}

// ============================================================
// 【缺口1修复】tool_choice 后处理校验
// ============================================================

/**
 * 对已解析的工具调用施加 tool_choice 约束。
 * 纯 prompt 软提示无法保证模型遵守 tool_choice，此处做硬性后处理。
 */
export function validateToolChoice(toolCalls, toolChoice, definedTools = []) {
  if (!toolCalls?.length && toolChoice === 'required') {
    return { toolCalls: null, content: null, warning: '[Tool choice was "required" but model returned no tool calls]' };
  }
  if (!toolCalls?.length) {
    return { toolCalls: null, content: null, warning: null };
  }
  if (toolChoice === 'none') {
    return { toolCalls: null, content: null, warning: '[Model returned tool calls despite tool_choice="none" — stripped]' };
  }
  const forcedName = toolChoice?.function?.name;
  if (forcedName) {
    const filtered = toolCalls.filter(tc => tc.function?.name === forcedName);
    if (filtered.length !== toolCalls.length) {
      return { toolCalls: filtered.length > 0 ? filtered : null, content: null, warning: `[${toolCalls.length - filtered.length} call(s) removed: only "${forcedName}" allowed]` };
    }
    return { toolCalls: filtered, content: null, warning: null };
  }
  return { toolCalls, content: null, warning: null };
}

/**
 * 【缺口3修复】工具名称白名单校验
 */
export function validateToolNames(toolCalls, definedTools = []) {
  if (!toolCalls?.length || !definedTools.length) return { toolCalls, filtered: 0 };
  const validNames = new Set(definedTools.map(t => t.function?.name).filter(Boolean));
  if (validNames.size === 0) return { toolCalls, filtered: 0 };
  const filtered = toolCalls.filter(tc => validNames.has(tc.function?.name));
  const removed = toolCalls.length - filtered.length;
  if (removed > 0) {
    const names = toolCalls.filter(tc => !validNames.has(tc.function?.name)).map(tc => tc.function?.name).filter(Boolean);
    console.warn(`[Tool validation] Removed ${removed} hallucinated tool(s): ${names.join(', ')}`);
  }
  return { toolCalls: filtered.length > 0 ? filtered : null, filtered: removed };
}

/**
 * 【缺口2修复】检测静默解析失败
 */
export function detectFailedToolParse(content, toolCallingEnabled) {
  if (!content || !toolCallingEnabled) return null;
  const lower = content.toLowerCase();
  if (lower.includes('<tool_calls')) return 'Content has <tool_calls> markup but failed to parse';
  if (/^\s*\{\s*"[^"]*"\s*:\s*/.test(lower) && /tool_calls/.test(lower)) return 'Content appears to have JSON tool calls but failed to parse';
  if (lower.includes('tool calling instructions') || lower.includes('available tools:')) return 'Content echoes tool-calling prompt instructions';
  return null;
}

// ============================================================
// 【防幻觉】内容消毒 — 剥离所有 prompt 泄漏和污染
// ============================================================

/**
 * 剥离模型输出中可能泄漏的系统 prompt 残留。
 * text-prompt 模式下，模型可能「复读」指令而不是执行。
 *
 * 覆盖的泄漏模式：
 *   - [System]: ...  — system prompt 头泄漏
 *   - [User]: ...    — 用户消息泄漏
 *   - [Assistant]: ... — 助手消息泄漏
 *   - [Tool result ...] — 工具结果泄漏
 *   - x-anthropic-billing-header: ... — 客户端元数据泄漏
 *   - Tool calling instructions — 工具定义复读
 *   - Available tools: — 工具列表复读
 *   - You have access to these tools: — 工具权限声明复读
 *   - [Assistant tool calls]: ... — 历史工具调用泄漏
 *
 * @param {string} text - 模型原始输出
 * @returns {string} 消毒后的文本
 */
export function sanitizeModelOutput(text) {
  if (!text) return text;

  // 剥离 [System]: 块（可能包含客户端的 system prompt）
  let result = text
    // [System]: x-anthropic-* 这类客户端元数据头
    .replace(/\[System\]:\s*x-anthropic-[^\n]*\n?/gi, '')
    // 整个 [System]: ... 块（直到下一个标记或结束）
    .replace(/\[System\]:[\s\S]*?(?=\[User\]|\[Assistant\]|$)/gi, '')
    // [User]: ... 块
    .replace(/\[User\]:[\s\S]*?(?=\[Assistant\]|\[Tool|$)/gi, '')
    // [Assistant tool calls]: ...
    .replace(/\[Assistant tool calls\]:[\s\S]*?(?=\n\[|\n*$)/gi, '')
    // [Tool result ...]: ... 块
    .replace(/\[Tool result[^\]]*\]:[\s\S]*?(?=\n\[|\n*$)/gi, '')
    // 孤立的 x-anthropic-* header
    .replace(/x-anthropic-[a-z-]+:\s*[^\n]+\n?/gi, '')
    // 工具指令复读
    .replace(/\[Tool calling instructions\][\s\S]*?(?=\[|\n\n|$)/g, '')
    // 工具列表复读
    .replace(/Available tools:\s*[\s\S]*?(?=\[|\n\n|$)/g, '')
    // You have access to/You are behind/You are an 这类指令残片
    .replace(/You (have access to|are behind|are an|must call|can answer)[^.]*\.\s*/gi, '')
    // 多余空行压缩
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  return result;
}

/**
 * 【缺口4修复】参数消毒
 */
export function sanitizeToolArguments(toolCalls) {
  if (!toolCalls?.length) return toolCalls || [];
  return toolCalls.map(tc => {
    const fn = tc.function;
    if (!fn) return tc;
    if (typeof fn.arguments === 'string') {
      try {
        const parsed = JSON.parse(fn.arguments);
        if (parsed !== null && typeof parsed === 'object') return { ...tc, function: { ...fn, arguments: JSON.stringify(parsed) } };
      } catch {
        console.warn(`[Tool args] Invalid JSON in "${fn.name}": ${fn.arguments.slice(0, 80)}`);
        return { ...tc, function: { ...fn, arguments: '{}' } };
      }
    }
    return tc;
  });
}

/**
 * 综合校验流水线：tool_choice → 白名单 → 参数消毒
 */
export function validateToolCallsPipeline(rawToolCalls, toolChoice, definedTools) {
  if (!rawToolCalls?.length) {
    const r = validateToolChoice(null, toolChoice, definedTools);
    return { toolCalls: null, warning: r.warning };
  }
  let calls = [...rawToolCalls];
  let warnings = [];
  const r1 = validateToolChoice(calls, toolChoice, definedTools);
  calls = r1.toolCalls;
  if (r1.warning) warnings.push(r1.warning);
  if (!calls?.length) return { toolCalls: null, warning: warnings.join('; ') || null };
  const r2 = validateToolNames(calls, definedTools);
  calls = r2.toolCalls;
  if (r2.filtered > 0) warnings.push(`Filtered ${r2.filtered} hallucinated tool(s)`);
  if (!calls?.length) return { toolCalls: null, warning: warnings.join('; ') || null };
  calls = sanitizeToolArguments(calls);
  if (warnings.length > 0) console.warn(`[Tool pipeline] ${warnings.join(' | ')}`);
  return { toolCalls: calls, warning: warnings.join('; ') || null };
}

// ============================================================
// 工具调用解析 — 鲁棒封装层
// ============================================================

function normalizeJsonQuotes(value) {
  if (typeof value !== 'string') return value;
  return value
    .replace(/[“”]/g, '"')
    .replace(/[‘’]/g, "'");
}

function tryParseJson(value) {
  try { return JSON.parse(value); } catch {
    try { return JSON.parse(normalizeJsonQuotes(value)); } catch { return null; }
  }
}

/**
 * Python桥提升2: 提取 code fence 中的内容
 * 例如：```json\n{"key": "value"}\n``` → {"key": "value"}
 *
 * 源自 python _extract_code_block
 */
export function extractCodeBlock(text) {
  const match = text.match(/```(?:json)?\s*(\{[\s\S]*?\})\s*```/);
  return match ? match[1].trim() : null;
}

/**
 * Python桥提升3: 深度计数提取第一个 JSON 对象
 *
 * 通过计数 {} 嵌套深度找到完整 JSON 对象。
 * 即使被 markdown、自然语言等包裹也能提取。
 *
 * 源自 python _extract_first_json_object
 *
 * 例如:
 *   "Sure!\n```json\n{"tool_calls":[...]}\n```" → 提取完整 JSON
 *   "Let me check. {"assistant_response": null, "tool_calls": [...]}" → 同样提取
 */
export function extractFirstJsonObject(text) {
  const start = text.indexOf('{');
  if (start < 0) return null;

  let depth = 0;
  let inString = false;
  let escape = false;

  for (let i = start; i < text.length; i++) {
    const char = text[i];

    if (inString) {
      if (escape) { escape = false; continue; }
      if (char === '\\') { escape = true; continue; }
      if (char === '"') { inString = false; continue; }
      continue;
    }

    if (char === '"') { inString = true; continue; }
    if (char === '{') { depth++; continue; }
    if (char === '}') {
      depth--;
      if (depth === 0) {
        return text.slice(start, i + 1);
      }
    }
  }

  return null;
}

/**
 * 提取最后一个 <tag>...</tag> 块中的内容
 * 支持标签后跟属性、代码块包裹
 */
export function extractJsonBlock(text, tag) {
  const cleanText = text.replace(/```(?:json|xml|)\s*/gi, '').replace(/```\s*$/gm, '');
  const open = `<${tag}`;
  const close = `</${tag}>`;
  const lowerText = cleanText.toLowerCase();
  const lastClose = lowerText.lastIndexOf(close);
  if (lastClose === -1) return null;
  const lastOpen = lowerText.lastIndexOf(open, lastClose);
  if (lastOpen === -1) return null;
  const inner = cleanText.slice(lastOpen + open.length, lastClose);
  const gt = inner.indexOf('>');
  const body = gt === -1 ? inner : inner.slice(gt + 1);
  const trimmed = body.trim();
  return trimmed || null;
}

/**
 * 从文本中移除工具调用标签
 * 支持不闭合的标签（防模型死循环）
 */
export function stripToolBlocks(text) {
  let result = text
    .replace(/```(?:json|xml|)\s*[\s\S]*?```/gi, '')
    // 完整的 <tool_calls>...</tool_calls> 对（含变体 tool_call_calls）
    .replace(/<tool_calls\b[^>]*>[\s\S]*?<\/tool_calls\s*>/gi, '')
    .replace(/<tool_call_calls[^>]*>[\s\S]*?<\/tool_call_calls\s*>/gi, '')
    .replace(/<tool_call\b[^>]*>[\s\S]*?<\/tool_call\s*>/gi, '')
    // 孤立的 <tool_calls> / <tool_call_calls> / <tool_call> 开头标签
    .replace(/<tool_calls\b[^>]*>/gi, '')
    .replace(/<tool_call_calls[^>]*>/gi, '')
    .replace(/<tool_call\b[^>]*>/gi, '')
    // 孤立的 </tool_calls> / </tool_call_calls> / </tool_call> 结尾标签
    .replace(/<\/tool_calls\s*>/gi, '')
    .replace(/<\/tool_call_calls\s*>/gi, '')
    .replace(/<\/tool_call\s*>/gi, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  return result;
}

/**
 * 标准化工具参数
 */
export function normalizeToolArguments(args) {
  if (args == null) return '{}';
  if (typeof args === 'string') {
    const trimmed = args.trim();
    if (!trimmed) return '{}';
    const parsed = tryParseJson(trimmed);
    return parsed === null ? trimmed : JSON.stringify(parsed);
  }
  try { return JSON.stringify(args); } catch { return '{}'; }
}

/**
 * 转换为 OpenAI 格式的 tool_calls
 */
export function toOpenAIToolCalls(calls) {
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

/**
 * Python桥提升4: 解析虚拟工具调用的 JSON 输出
 *
 * 当模型以 JSON 格式输出工具调用时（TOOL_FORMAT=json）：
 *   {"assistant_response": "思考过程", "tool_calls": [{"name":"x","arguments":{}}]}
 *
 * 解析策略（逐级降级）:
 *   1. 直接解析 text 整体
 *   2. 提取 code block 后解析
 *   3. 深度计数提取第一个 JSON 对象
 *
 * 源自 python _parse_virtual_tool_output
 */
export function parseVirtualToolJSON(text) {
  if (!text) return null;

  const stripped = text.trim();

  // 先找出第一个 JSON 对象的位置，提取前缀
  const firstJson = extractFirstJsonObject(stripped);
  const firstJsonIndex = firstJson ? stripped.indexOf(firstJson) : -1;
  const prefixText = firstJsonIndex > 0 ? stripped.slice(0, firstJsonIndex).trim() : '';

  const candidates = [];

  // 1. 整体
  if (stripped) candidates.push(stripped);

  // 2. code block 包裹
  const codeBlock = extractCodeBlock(stripped);
  if (codeBlock && !candidates.includes(codeBlock)) candidates.push(codeBlock);

  // 3. 第一个 JSON 对象（深度计数）
  if (firstJson && !candidates.includes(firstJson)) candidates.push(firstJson);

  for (const candidate of candidates) {
    const parsed = tryParseJson(candidate);
    if (!parsed || typeof parsed !== 'object') continue;

    let rawToolCalls = parsed.tool_calls;
    // 兼容 {name, arguments} 直接在外层的情况
    if (rawToolCalls === undefined && parsed.name) {
      rawToolCalls = [parsed];
    }

    const toolCalls = [];
    if (Array.isArray(rawToolCalls)) {
      for (const raw of rawToolCalls) {
        if (!raw || typeof raw !== 'object') continue;
        let name = raw.name;
        // 尝试从 function 子对象获取 name
        if (!name && raw.function) name = raw.function.name;
        if (!name || typeof name !== 'string' || !name.trim()) continue;

        const args = raw.arguments !== undefined ? raw.arguments
          : (raw.function?.arguments !== undefined ? raw.function.arguments
          : raw.args);

        toolCalls.push({
          name: name.trim(),
          arguments: typeof args === 'object' && args !== null && !Array.isArray(args)
            ? JSON.stringify(args) : normalizeToolArguments(args),
        });
      }
    }

    const assistantResponse = parsed.assistant_response
      ?? parsed.content ?? parsed.response ?? parsed.answer ?? null;

    if (toolCalls.length > 0 || typeof assistantResponse === 'string') {
      const mergedContent = [prefixText, assistantResponse]
        .filter(Boolean)
        .map(s => s.trim())
        .join(String.fromCharCode(10, 10)) || null;

      return {
        toolCalls: toolCalls.length > 0 ? toolCalls.map((tc, i) => ({
          id: `call_${Date.now().toString(36)}_${i}_${Math.random().toString(36).slice(2, 8)}`,
          type: 'function',
          function: { name: tc.name, arguments: tc.arguments },
        })) : null,
        content: mergedContent,
      };
    }
  }

  return null;
}

/**
 * 从模型输出文本中解析工具调用 — 核心鲁棒解析器
 *
 * 解析优先级（按 prompt 格式选择）：
 *   1. <tool_calls> / <tool_call> XML 块（默认 XML prompt 格式）
 *   2. JSON 格式虚拟工具调用（JSON prompt 格式，TOOL_FORMAT=json）
 *   3. 裸 JSON 兜底
 *
 * 规则：XML 优先于 JSON——因为我们精确控制 prompt 内容，
 * 大多数情况下模型按我们的指令输出 XML。
 */
export function parseToolCallsFromText(text) {
  if (!text) return null;

  // 策略1: XML 标签格式（默认 prompt 格式，最高优先级）
  const blocks = [
    extractJsonBlock(text, 'tool_calls'),
    extractJsonBlock(text, 'tool_call'),
  ].filter(Boolean);

  for (const block of blocks) {
    const parsed = tryParseJson(block);
    if (!parsed) continue;
    const calls = Array.isArray(parsed) ? parsed : [parsed];
    const toolCalls = toOpenAIToolCalls(calls);
    if (toolCalls.length) {
      return { toolCalls, content: stripToolBlocks(text) };
    }
  }

  // 策略2: JSON 虚拟工具调用格式（TOOL_FORMAT=json 时使用）
  const jsonResult = parseVirtualToolJSON(text);
  if (jsonResult?.toolCalls?.length) {
    return jsonResult;
  }

  // 策略3: 裸 JSON 兜底
  const trimmed = text.trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/```\s*$/i, '')
    .trim();
  const parsed = tryParseJson(trimmed);
  if (parsed) {
    const rawCalls = parsed.tool_calls || parsed.tools || parsed.calls || parsed.function_call || parsed;
    const calls = Array.isArray(rawCalls) ? rawCalls : [rawCalls];
    const toolCalls = toOpenAIToolCalls(calls);
    if (toolCalls.length) return { toolCalls, content: '' };
  }

  // 策略4: 深度扫描兜底 — 全文扫描所有 {…} 对象
  const recoveryResult = recoverToolCallsFromText(text);
  if (recoveryResult?.toolCalls?.length) {
    return recoveryResult;
  }

  // 策略5: 【防死循环】检测到工具调用标签但解析全部失败
  // 不返回 null，而是返回剥离后的纯内容（避免原始标签泄漏到客户端）
  if (/<tool_calls\b/i.test(text) || /<tool_call_calls/i.test(text)) {
    const cleaned = stripToolBlocks(text);
    const sanitized = sanitizeModelOutput(cleaned);
    console.warn(`[Tool abort] Stripped malformed <tool_calls> from output (${text.length - cleaned.length} chars removed). Returning as text.`);
    return {
      toolCalls: null,
      content: sanitized || '[The model attempted to use tools but the output was malformed and has been cleaned up]',
    };
  }

  // 策略6: 【防泄漏】检测 content 包含系统 prompt 泄漏
  // 即使没有工具调用标记，也要防止 prompt 残片泄漏到客户端
  const sanitized = sanitizeModelOutput(text);
  if (sanitized !== text) {
    console.warn(`[Content sanitize] Stripped ${text.length - sanitized.length} chars of leaked prompt artifacts`);
    return {
      toolCalls: null,
      content: sanitized || null,
    };
  }

  return null;
}

// ============================================================
// 【缺口修复】正则兜底提取
// ============================================================

/**
 * 正则兜底提取 — 当标准 JSON/XML 解析均失败时使用
 *
 * 使用深度计数提取文本中所有 JSON 对象，逐一检查是否包含工具调用。
 * 比 extractFirstJsonObject 更全面——扫描全文而非只找第一个。
 *
 * 覆盖场景：
 *   1. 嵌套/空 XML 标签：<tool_calls>\n<tool_calls>\n\n</tool_calls>
 *   2. JSON 字符串作为 tool_calls 值（非数组）
 *   3. 工具调用参数被转义为字符串
 *   4. 多个 JSON 对象散落在文本中
 */
export function recoverToolCallsFromText(text) {
  if (!text) return null;

  const results = [];

  // 深度计数提取所有 {…} 对象
  let searchStart = 0;
  while (searchStart < text.length) {
    const start = text.indexOf('{', searchStart);
    if (start < 0) break;

    let depth = 0;
    let inString = false;
    let escape = false;
    let end = -1;

    for (let i = start; i < text.length; i++) {
      const char = text[i];
      if (inString) {
        if (escape) { escape = false; continue; }
        if (char === '\\') { escape = true; continue; }
        if (char === '"') { inString = false; continue; }
        continue;
      }
      if (char === '"') { inString = true; continue; }
      if (char === '{') { depth++; continue; }
      if (char === '}') {
        depth--;
        if (depth === 0) { end = i + 1; break; }
      }
    }

    if (end < 0) break; // 无闭合对象，退出

    const candidate = text.slice(start, end);
    searchStart = end;

    // 尝试解析
    const parsed = tryParseJson(candidate);
    if (!parsed || typeof parsed !== 'object') continue;

    // 1. tool_calls 是数组
    let raw = parsed.tool_calls || parsed.tools || parsed.calls;
    if (Array.isArray(raw)) {
      const calls = toOpenAIToolCalls(raw);
      if (calls.length) results.push(...calls);
    }
    // 2. tool_calls 是字符串（被序列化）
    if (typeof raw === 'string') {
      const unescaped = raw.replace(/\\"/g, '"').replace(/\\n/g, '');
      const innerParsed = tryParseJson(unescaped);
      if (Array.isArray(innerParsed)) {
        const calls = toOpenAIToolCalls(innerParsed);
        if (calls.length) results.push(...calls);
      }
    }
    // 3. 顶层 name + arguments 作为单工具调用
    if (results.length === 0 && parsed.name && typeof parsed.name === 'string') {
      const call = { name: parsed.name, arguments: parsed.arguments ?? parsed.args ?? {} };
      const calls = toOpenAIToolCalls([call]);
      if (calls.length) results.push(...calls);
    }
  }

  // 去重（同名 + 同参数视为重复）
  const seen = new Set();
  const unique = results.filter(tc => {
    const key = `${tc.function.name}:${tc.function.arguments}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  if (unique.length > 0) {
    console.warn(`[Tool recovery] Recovered ${unique.length} tool call(s) via depth-scan fallback`);
    return {
      toolCalls: unique,
      content: stripToolBlocks(text) || null,
    };
  }

  return null;
}

// ============================================================
// OpenAI 流式工具调用增量输出
// ============================================================

const ARGS_CHUNK_SIZE = 24;

export function streamToolCallsIncremental(res, writeOpts, toolCalls) {
  for (let i = 0; i < toolCalls.length; i++) {
    const tc = toolCalls[i];
    if (!writeSSE(res, {
      ...writeOpts,
      choices: [{
        index: 0,
        delta: {
          tool_calls: [{
            index: i, id: tc.id, type: 'function',
            function: { name: tc.function.name, arguments: '' },
          }],
        },
        finish_reason: null,
      }],
    })) return;

    const args = tc.function.arguments || '';
    for (let j = 0; j < args.length; j += ARGS_CHUNK_SIZE) {
      if (!writeSSE(res, {
        ...writeOpts,
        choices: [{
          index: 0,
          delta: {
            tool_calls: [{ index: i, function: { arguments: args.slice(j, j + ARGS_CHUNK_SIZE) } }],
          },
          finish_reason: null,
        }],
      })) return;
    }
  }
}

// ============================================================
// Python桥提升5: 工具历史检测
//
// 检查消息列表中是否包含工具调用历史。
// 即使当前请求没有 tools 参数，如果历史中有工具调用，
// 模型仍可能继续输出工具调用。
// ============================================================

/**
 * 检测消息中是否有工具调用历史
 * 检查 tool 角色消息或 assistant 消息中的 tool_calls
 *
 * 源自 python _has_tool_history
 */
export function hasToolHistory(messages) {
  if (!Array.isArray(messages)) return false;
  for (const msg of messages) {
    if (!msg || typeof msg !== 'object') continue;
    const role = (msg.role || '').toLowerCase();
    if (role === 'tool') return true;
    if (role === 'assistant' && Array.isArray(msg.tool_calls) && msg.tool_calls.length > 0) return true;
  }
  return false;
}

// ============================================================
// Prompt 构建工具
// ============================================================

function buildPromptInner(messages, startIdx, endIdx) {
  let prompt = '';
  for (let i = startIdx; i < endIdx; i++) {
    const msg = messages[i];
    if (msg.role === 'system') {
      prompt += `[System]: ${textFromContent(msg.content)}\n\n`;
    } else if (msg.role === 'user') {
      prompt += `[User]: ${textFromContent(msg.content)}\n\n`;
    } else if (msg.role === 'assistant') {
      const content = textFromContent(msg.content);
      if (content) prompt += `[Assistant]: ${content}\n\n`;
      if (Array.isArray(msg.tool_calls) && msg.tool_calls.length) {
        prompt += `[Assistant tool calls]: ${JSON.stringify(msg.tool_calls)}\n\n`;
      }
    } else if (msg.role === 'tool') {
      const name = msg.name || msg.tool_call_id || 'tool';
      prompt += `[Tool result ${name}]: ${textFromContent(msg.content)}\n\n`;
    } else if (msg.role === 'function') {
      prompt += `[Function result ${msg.name || 'function'}]: ${textFromContent(msg.content)}\n\n`;
    }
  }
  return prompt.trim();
}

export function buildPromptFromMessages(messages) {
  return buildPromptInner(messages, 0, messages.length);
}

export function buildLatestPrompt(messages) {
  let lastUserIdx = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === 'user') { lastUserIdx = i; break; }
  }
  if (lastUserIdx === -1) return buildPromptFromMessages(messages);
  return buildPromptInner(messages, lastUserIdx, messages.length);
}

// ============================================================
// 全局未处理 rejection 防护
// ============================================================

export function setupUnhandledRejectionHandler() {
  process.on('unhandledRejection', (reason) => {
    const msg = reason?.message || String(reason || 'unknown');
    if (msg.includes('cancel') || msg.includes('abort') || msg.includes('pipe')) return;
    console.error(`[HA] Unhandled Rejection: ${msg}`);
  });
}
