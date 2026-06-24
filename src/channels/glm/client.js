/**
 * GLM API 客户端
 *
 * 封装 GLM API 调用逻辑，包括消息转换、流解析等
 *
 * 重构要点：
 * - 使用共享工具函数（response-utils.js）处理工具相关的逻辑
 * - 使用共享的 textFromContent 和 buildToolInstructions
 */

import { makeTimestamp, makeNonce, makeSign, makeAuthHeaders } from './utils.js';
import { textFromContent, buildToolInstructions, normalizeTools } from '../../utils/response-utils.js';

const ASSISTANT_STREAM_URL = 'https://chatglm.cn/chatglm/backend-api/assistant/stream';
const DEFAULT_ASSISTANT_ID = '65940acff94777010aa6b796';

// ============================================================
// 消息格式转换 — OpenAI → GLM
// ============================================================

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
      result.push({
        role: 'user',
        content: [{ type: 'text', text: `[Tool result from ${name}]: ${textFromContent(msg.content)}` }],
      });
    } else if (msg.role === 'assistant' && Array.isArray(msg.tool_calls) && msg.tool_calls.length) {
      const text = textFromContent(msg.content);
      const calls = msg.tool_calls
        .map((tc) => `${tc.function.name}(${tc.function.arguments})`)
        .join(', ');
      const desc = text
        ? `${text}\n\n[Assistant called tools: ${calls}]`
        : `[Assistant called tools: ${calls}]`;
      result.push({ role: 'assistant', content: [{ type: 'text', text: desc }] });
    } else if (msg.role === 'system') {
      result.push({ role: 'user', content: [{ type: 'text', text: `[System]: ${textFromContent(msg.content)}` }] });
    } else if (msg.role === 'function') {
      result.push({ role: 'user', content: [{ type: 'text', text: `[Function result ${msg.name || 'function'}]: ${textFromContent(msg.content)}` }] });
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
    parts.push(`<|${tag}|>\n${textFromContent(msg.content)}`);
  }
  parts.push('<|assistant|>\n');

  return [
    { role: 'user', content: [{ type: 'text', text: parts.join('\n') }] },
  ];
}

/**
 * 将 OpenAI 格式消息转换为 GLM 格式
 * @param {Array} messages - OpenAI 格式消息
 * @param {Array} [tools=[]] - 工具定义，非空时附加工具调用指令
 */
export function convertMessages(messages, tools = []) {
  const result = messagesPrepare(convertToolMessages(messages));
  // 将工具定义指令注入到最后一条 user 消息末尾
  if (tools.length) {
    const instructions = buildToolInstructions(tools);
    if (instructions) {
      const lastMsg = result[result.length - 1];
      if (lastMsg?.content?.[0]?.text) {
        lastMsg.content[0].text += '\n\n' + instructions;
      }
    }
  }
  return result;
}

// ============================================================
// 构建最终发送给 GLM 的 prompt
// ============================================================

/**
 * 构建最终发送给 GLM 的 prompt
 * 将系统消息、对话历史和工具定义合并
 */
export function buildPrompt(messages, tools = []) {
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
  return (prompt.trim() + buildToolInstructions(tools)).trim();
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

  const ts = makeTimestamp();
  const nonce = makeNonce();
  const sign = makeSign(ts, nonce);
  const headers = {
    ...makeAuthHeaders(ts, nonce, sign),
    Authorization: `Bearer ${accessToken}`,
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
    Referer: 'https://chatglm.cn/',
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

// 导出共享的 normalizeTools、buildToolInstructions、textFromContent 供 handlers 使用
export { normalizeTools, textFromContent };
