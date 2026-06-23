/**
 * GLM API 客户端
 *
 * 封装 GLM API 调用逻辑，包括消息转换、流解析等
 */

import { makeUuid } from './utils.js';

const ASSISTANT_STREAM_URL = 'https://chatglm.cn/chatglm/backend-api/assistant/stream';
const DEFAULT_ASSISTANT_ID = '65940acff94777010aa6b796';

// ============================================================
// 消息格式转换 — OpenAI → GLM
// ============================================================

function textFromContent(content) {
  if (content == null) return '';
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.map((part) => {
      if (part.type === 'text') return part.text || '';
      if (part.type === 'image_url') return '[Image]';
      return JSON.stringify(part);
    }).filter(Boolean).join('\n');
  }
  return JSON.stringify(content);
}

function extractText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.map((part) => {
      if (part.type === 'text') return part.text || '';
      if (part.type === 'image_url') return '[Image]';
      return JSON.stringify(part);
    }).filter(Boolean).join('\n');
  }
  return JSON.stringify(content);
}

/**
 * Step 1: 工具调用转换
 * - tool role → user（自然语言包装结果）
 * - assistant + tool_calls → assistant + 描述文本
 */
function convertToolMessages(messages) {
  const result = [];
  for (const msg of messages) {
    if (msg.role === 'tool') {
      const name = msg.name || msg.tool_call_id || 'tool';
      const content = textFromContent(msg.content);
      result.push({
        role: 'user',
        content: [{ type: 'text', text: `[Tool result from ${name}]: ${content}` }],
      });
    } else if (msg.role === 'assistant' && Array.isArray(msg.tool_calls) && msg.tool_calls.length) {
      const text = textFromContent(msg.content);
      const calls = msg.tool_calls
        .map((tc) => `${tc.function.name}(${tc.function.arguments})`)
        .join(', ');
      const desc = text
        ? `${text}\n\n[Assistant called tools: ${calls}]`
        : `[Assistant called tools: ${calls}]`;
      result.push({
        role: 'assistant',
        content: [{ type: 'text', text: desc }],
      });
    } else if (msg.role === 'system') {
      result.push({
        role: 'user',
        content: [{ type: 'text', text: `[System]: ${textFromContent(msg.content)}` }],
      });
    } else if (msg.role === 'function') {
      result.push({
        role: 'user',
        content: [{ type: 'text', text: `[Function result ${msg.name || 'function'}]: ${textFromContent(msg.content)}` }],
      });
    } else {
      const content = Array.isArray(msg.content)
        ? msg.content
        : [{ type: 'text', text: textFromContent(msg.content) }];
      result.push({ role: msg.role, content });
    }
  }
  return result;
}

/**
 * Step 2: 多轮对话合并为单条 user 消息
 * 使用 <|user|> / <|assistant|> 标签分隔
 */
function messagesPrepare(converted) {
  const parts = [];
  for (const msg of converted) {
    const tag = msg.role === 'user' ? 'user' : 'assistant';
    const text = extractText(msg.content);
    parts.push(`<|${tag}|>\n${text}`);
  }
  parts.push('<|assistant|>\n');

  return [
    {
      role: 'user',
      content: [{ type: 'text', text: parts.join('\n') }],
    },
  ];
}

/**
 * 将 OpenAI 格式消息转换为 GLM 格式
 */
export function convertMessages(messages) {
  const step1 = convertToolMessages(messages);
  return messagesPrepare(step1);
}

// ============================================================
// 工具调用支持
// ============================================================

function normalizeTools(tools) {
  if (!Array.isArray(tools)) return [];
  return tools
    .filter((t) => t?.type === 'function' && t.function?.name)
    .map((t) => ({
      type: 'function',
      function: {
        name: t.function.name,
        description: t.function.description || '',
        parameters: t.function.parameters || { type: 'object', properties: {} },
      },
    }));
}

function buildToolInstructions(tools) {
  if (!tools.length) return '';

  return (
    `\n\n[Tool calling instructions]\nYou have access to these tools:\n${JSON.stringify(tools, null, 2)}\n\n` +
    'Use a tool only when it is helpful or required to answer correctly.\n\n' +
    'If you decide to call tools, do not answer normally. Output exactly one XML block and nothing else:\n' +
    '<tool_calls>[{"name":"tool_name","arguments":{"arg":"value"}}]</tool_calls>\n\n' +
    'Rules:\n' +
    '- The content inside <tool_calls> must be valid JSON.\n' +
    '- "arguments" must be a JSON object matching the tool schema.\n' +
    '- For a single tool call, still use a JSON array with one item.\n' +
    '- If no tool is needed, answer normally without the <tool_calls> block.'
  );
}

/**
 * 构建最终发送给 GLM 的 prompt
 * 将系统消息、对话历史和工具定义合并
 */
export function buildPrompt(messages, tools) {
  let prompt = '';
  for (const msg of messages) {
    const content = textFromContent(msg.content);
    if (msg.role === 'system') {
      prompt += `[System]: ${content}\n\n`;
    } else if (msg.role === 'user') {
      prompt += `[User]: ${content}\n\n`;
    } else if (msg.role === 'assistant') {
      if (content) prompt += `[Assistant]: ${content}\n\n`;
      if (Array.isArray(msg.tool_calls) && msg.tool_calls.length) {
        prompt += `[Assistant tool calls]: ${JSON.stringify(msg.tool_calls)}\n\n`;
      }
    } else if (msg.role === 'tool') {
      const name = msg.name || msg.tool_call_id || 'tool';
      prompt += `[Tool result ${name}]: ${textFromContent(msg.content)}\n\n`;
    }
  }
  return (prompt.trim() + buildToolInstructions(normalizeTools(tools))).trim();
}

// ============================================================
// 工具调用解析
// ============================================================

function tryParseJson(value) {
  try { return JSON.parse(value); } catch { return null; }
}

function extractJsonBlock(text, tag) {
  const open = `<${tag}`;
  const close = `</${tag}>`;
  const lastClose = text.toLowerCase().lastIndexOf(close);
  if (lastClose === -1) return null;
  const lastOpen = text.toLowerCase().lastIndexOf(open, lastClose);
  if (lastOpen === -1) return null;
  const inner = text.slice(lastOpen + open.length, lastClose);
  const gt = inner.indexOf('>');
  const body = gt === -1 ? inner : inner.slice(gt + 1);
  const trimmed = body.trim();
  return trimmed || null;
}

function stripToolBlocks(text) {
  return text
    .replace(/<tool_calls\b[^>]*>[\s\S]*?<\/tool_calls>/gi, '')
    .replace(/<tool_call\b[^>]*>[\s\S]*?<\/tool_call>/gi, '')
    .trim();
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

export function parseToolCallsFromText(text) {
  if (!text) return null;

  const blocks = [
    extractJsonBlock(text, 'tool_calls'),
    extractJsonBlock(text, 'tool_call'),
  ].filter(Boolean);

  for (const block of blocks) {
    const parsed = tryParseJson(block);
    if (!parsed) continue;
    const calls = Array.isArray(parsed) ? parsed : [parsed];
    const toolCalls = toOpenAIToolCalls(calls);
    if (toolCalls.length) return { toolCalls, content: stripToolBlocks(text) };
  }

  const trimmed = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/```$/i, '').trim();
  const parsed = tryParseJson(trimmed);
  if (parsed) {
    const rawCalls = parsed.tool_calls || parsed.tools || parsed.calls || parsed.function_call || parsed;
    const calls = Array.isArray(rawCalls) ? rawCalls : [rawCalls];
    const toolCalls = toOpenAIToolCalls(calls);
    if (toolCalls.length) return { toolCalls, content: '' };
  }

  return null;
}

// ============================================================
// GLM API 调用
// ============================================================

/**
 * 调用 GLM assistant/stream 端点
 *
 * @param {Array} glmMessages - 已转换为 GLM 格式的消息
 * @param {object} options
 * @param {string} options.assistantId - 模型 assistant_id
 * @param {boolean} options.plusModel - 是否启用增强模型
 * @param {boolean} options.searchEnabled - 是否联网搜索
 * @param {string} options.conversationId - 续传会话 ID
 * @param {string} options.chatMode - 特殊模式（zero/deep_research）
 * @param {object} options.tokenManager - Token 管理器
 * @returns {Promise<ReadableStream>} GLM API 返回的流
 */
export async function glmChatCompletion(glmMessages, options = {}) {
  const { tokenManager } = options;

  if (!tokenManager) {
    throw new Error('GLM tokenManager is required');
  }

  const accessToken = await tokenManager.getAccessToken();

  const body = {
    assistant_id: options.assistantId || DEFAULT_ASSISTANT_ID,
    conversation_id: options.conversationId || '',
    project_id: '',
    chat_type: 'user_chat',
    messages: glmMessages,
    meta_data: {
      channel: '',
      chat_mode: options.chatMode || '',
      draft_id: '',
      if_plus_model: options.plusModel ?? true,
      input_question_type: 'xxxx',
      is_networking: options.searchEnabled ?? true,
      is_test: false,
      platform: 'pc',
      quote_log_id: '',
      cogview: {},
    },
  };

  const headers = {
    Authorization: `Bearer ${accessToken}`,
    'Content-Type': 'application/json',
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
    Origin: 'https://chatglm.cn',
    Referer: 'https://chatglm.cn/',
    'X-Request-Id': makeUuid(),
  };

  const res = await fetch(ASSISTANT_STREAM_URL, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    // 401 → token 可能过期，重置并重试
    if (res.status === 401) {
      tokenManager.reset();
      const newToken = await tokenManager.getAccessToken();
      headers.Authorization = `Bearer ${newToken}`;
      const retryRes = await fetch(ASSISTANT_STREAM_URL, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
      });
      if (!retryRes.ok) {
        const text = await retryRes.text();
        throw new Error(`GLM API error ${retryRes.status}: ${text}`);
      }
      return retryRes.body;
    }
    const text = await res.text();
    throw new Error(`GLM API error ${res.status}: ${text}`);
  }

  return res.body;
}
