import { chatHeaders, requestHeaders } from './headers.js';
import { buildToolInstructions, normalizeTools, textFromContent } from '../../utils/response-utils.js';

const BASE_URL = 'https://chat.qwen.ai';

function compactSnippet(text, maxLength = 200) {
  return String(text || '').replace(/\s+/g, ' ').trim().slice(0, maxLength);
}

function createChatModeFor(chatMode) {
  return chatMode === 't2t' ? 'normal' : chatMode;
}

async function readJsonResponse(res, context) {
  const text = await res.text();
  try {
    return text ? JSON.parse(text) : null;
  } catch {
    const contentType = res.headers.get('content-type') || 'unknown content-type';
    const looksHtml = /^\s*</.test(text);
    const detail = looksHtml
      ? 'received HTML instead of JSON, likely a Qwen/WAF challenge or expired web session'
      : `received non-JSON response: ${compactSnippet(text, 120)}`;
    throw new Error(`${context} failed: HTTP ${res.status} ${contentType}; ${detail}`);
  }
}

export function buildQwenMessages(messages, tools = [], toolChoice = 'auto') {
  const parts = [];
  let hasToolResult = false;

  for (const msg of messages || []) {
    const content = textFromContent(msg.content);
    if (msg.role === 'system') {
      parts.push(`[System]: ${content}`);
    } else if (msg.role === 'user') {
      parts.push(`[User]: ${content}`);
    } else if (msg.role === 'assistant') {
      if (content) parts.push(`[Assistant]: ${content}`);
      if (Array.isArray(msg.tool_calls) && msg.tool_calls.length) {
        parts.push(`[Assistant tool calls]: ${JSON.stringify(msg.tool_calls)}`);
      }
    } else if (msg.role === 'tool') {
      const name = msg.name || msg.tool_call_id || 'tool';
      parts.push(`[Tool result ${name}]: ${content}`);
      hasToolResult = true;
    } else if (msg.role === 'function') {
      parts.push(`[Function result ${msg.name || 'function'}]: ${content}`);
      hasToolResult = true;
    } else {
      parts.push(`[${msg.role || 'message'}]: ${content}`);
    }
  }

  if (hasToolResult) {
    parts.push('[Tool result instruction]: 上面是客户端已经执行工具后返回的真实结果。请基于这些工具结果继续完成用户请求；如果无需继续调用工具，必须在 assistant_response 中反馈已完成的操作、关键结果和验证情况，禁止空回复结束多轮任务。');
  }

  const instructions = buildToolInstructions(normalizeTools(tools), toolChoice);
  if (instructions) parts.push(instructions);

  return [{ role: 'user', content: parts.filter(Boolean).join('\n\n') }];
}

export async function createChat({ token, model, chatMode = 't2t', signal, tokenManager }) {
  const upstreamChatMode = createChatModeFor(chatMode);
  const res = await fetch(`${BASE_URL}/api/v2/chats/new`, {
    method: 'POST',
    headers: requestHeaders({
      Authorization: `Bearer ${token}`,
      Referer: 'https://chat.qwen.ai/c/new-chat',
    }),
    body: JSON.stringify({
      title: '新建对话',
      models: [model],
      chat_mode: upstreamChatMode,
      chat_type: chatMode,
      timestamp: Date.now(),
      project_id: '',
    }),
    signal,
  });

  let json;
  try {
    json = await readJsonResponse(res, 'Qwen create chat');
  } catch (err) {
    tokenManager?.reportTokenFailure(token, { statusCode: res.status, message: err.message });
    throw err;
  }

  if (!res.ok) {
    const message = json?.detail || json?.message || json?.error || res.statusText || JSON.stringify(json);
    tokenManager?.reportTokenFailure(token, { statusCode: res.status, message });
    throw new Error(`Qwen create chat failed: HTTP ${res.status}: ${message}`);
  }

  const chatId = json.data?.id;
  if (!chatId) {
    const message = `missing chat id in response: ${JSON.stringify(json)}`;
    tokenManager?.reportTokenFailure(token, { statusCode: res.status, message });
    throw new Error(`Qwen create chat failed: ${message}`);
  }
  return chatId;
}

export async function qwenChatCompletion({
  token,
  model,
  messages,
  chatMode = 't2t',
  thinkingEnabled = false,
  searchEnabled = false,
  signal,
  tokenManager,
}) {
  const chatId = await createChat({ token, model, chatMode, signal, tokenManager });
  const timestamp = Math.floor(Date.now() / 1000);

  const isImageMode = chatMode === 't2i';
  const isVideoMode = chatMode === 't2v';
  const isDeepResearch = chatMode === 'deep_research';
  const featureConfig = {
    thinking_enabled: isImageMode || isVideoMode ? false : thinkingEnabled,
    output_schema: 'phase',
    research_mode: isDeepResearch ? 'deep' : 'normal',
    auto_thinking: isImageMode || isVideoMode ? false : thinkingEnabled,
    thinking_mode: (isImageMode || isVideoMode || !thinkingEnabled) ? 'Disabled' : 'Auto',
    thinking_format: 'summary',
    auto_search: isImageMode || isVideoMode ? false : searchEnabled,
  };

  const body = {
    stream: true,
    version: '2.1',
    incremental_output: true,
    chat_id: chatId,
    chat_mode: chatMode,
    model,
    parent_id: null,
    messages: messages.map(msg => ({
      fid: crypto.randomUUID(),
      parentId: null,
      childrenIds: [crypto.randomUUID()],
      role: msg.role,
      content: msg.content,
      user_action: 'chat',
      files: [],
      timestamp,
      models: [model],
      chat_type: chatMode,
      feature_config: featureConfig,
      extra: { meta: { subChatType: chatMode } },
      sub_chat_type: chatMode,
      parent_id: null,
    })),
    timestamp,
  };

  const res = await fetch(`${BASE_URL}/api/v2/chat/completions?chat_id=${chatId}`, {
    method: 'POST',
    headers: chatHeaders(token, chatId),
    body: JSON.stringify(body),
    signal,
  });

  if (!res.ok) {
    const text = await res.text();
    tokenManager?.reportTokenFailure(token, { statusCode: res.status, message: text.slice(0, 200) });
    throw new Error(`Qwen completion failed: ${res.status} ${text}`);
  }

  tokenManager?.reportTokenSuccess(token);
  return res.body;
}
