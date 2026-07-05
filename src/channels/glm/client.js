/**
 * GLM API 客户端
 *
 * 封装 GLM API 调用逻辑，包括消息转换、流解析等
 *
 * 重构要点：
 * - 使用共享 textFromContent 处理内容文本
 * - 工具说明由调用方的 prompt strategy 生成并传入
 */

import { makeTimestamp, makeNonce, makeSign, makeAuthHeaders } from './utils.js';
import { normalizeTools, textFromContent } from '../../utils/response-utils.js';
import { resolveUploadableBytes } from '../../utils/message-files.js';

const ASSISTANT_STREAM_URL = 'https://chatglm.cn/chatglm/backend-api/assistant/stream';
const FILE_UPLOAD_URL = 'https://chatglm.cn/chatglm/productivity-api/file/chat_upload';
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
        content: [{ type: 'text', text: `[Tool result from ${name}]: ${textFromContent(msg.content)}\n\n[Tool result instruction]: 上面是客户端已经执行工具后返回的真实结果。请基于这些工具结果继续完成用户请求；如果无需继续调用工具，请直接用自然语言反馈已完成的操作、关键结果和验证情况，禁止空回复结束多轮任务。` }],
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
  // GLM Web accepts native user message blocks. For the common single-turn case,
  // do not wrap the text in synthetic <|user|>/<|assistant|> transcript tags:
  // GLM-5.2 can treat those control-like markers as special/garbled input and
  // answer with “无法理解/乱码”. Keep transcript flattening only for multi-turn or
  // non-user history where role preservation is needed.
  if (converted.length === 1 && converted[0]?.role === 'user') {
    return [{ role: 'user', content: converted[0].content }];
  }

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
 * @param {object} [options]
 * @param {string} [options.toolInstructions] - 调用方生成的工具说明，必须与解析器使用同一个 trigger
 */
export function convertMessages(messages, options = {}) {
  const { toolInstructions = '' } = options || {};
  const result = messagesPrepare(convertToolMessages(messages));
  if (toolInstructions) {
    const lastMsg = result[result.length - 1];
    if (lastMsg?.content?.[0]?.text) {
      lastMsg.content[0].text += '\n\n' + toolInstructions;
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
export function buildPrompt(messages, options = {}) {
  const { toolInstructions = '' } = options || {};
  let prompt = '';
  let hasToolResult = false;
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
      hasToolResult = true;
    } else if (msg.role === 'function') {
      const name = msg.name || 'function';
      prompt += `[Function result ${name}]: ${textFromContent(msg.content)}\n\n`;
      hasToolResult = true;
    }
  }
  if (hasToolResult) {
    prompt += `[Tool result instruction]: 上面是客户端已经执行工具后返回的真实结果。请基于这些工具结果继续完成用户请求；如果无需继续调用工具，请直接用自然语言反馈已完成的操作、关键结果和验证情况，禁止空回复结束多轮任务。\n\n`;
  }
  return (prompt.trim() + (toolInstructions || '')).trim();
}

function glmFileContentTypeFor(file, result) {
  const mime = String(file.mimeType || result.file_type || '').toLowerCase();
  if (file.kind === 'image' || mime.startsWith('image/')) return 'image';
  if (file.kind === 'video' || mime.startsWith('video/')) return 'video';
  return 'file';
}

async function uploadGlmFile({ accessToken, file, assistantId, signal }) {
  const { buffer, mimeType } = await resolveUploadableBytes(file);
  const form = new FormData();
  form.append('file', new Blob([buffer], { type: mimeType || file.mimeType || 'application/octet-stream' }), file.filename || 'uploaded-file');
  form.append('from', 'chat');
  if (assistantId) form.append('assistant_id', assistantId);

  const ts = makeTimestamp();
  const nonce = makeNonce();
  const sign = makeSign(ts, nonce);
  const headers = {
    ...makeAuthHeaders(ts, nonce, sign),
    Authorization: `Bearer ${accessToken}`,
    Origin: 'https://chatglm.cn',
    Referer: 'https://chatglm.cn/',
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
  };
  delete headers['Content-Type'];

  const res = await fetch(FILE_UPLOAD_URL, {
    method: 'POST',
    headers,
    body: form,
    signal,
  });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch {
    throw new Error(`GLM file upload failed: invalid JSON response: ${text.slice(0, 200)}`);
  }
  if (!res.ok || json?.status !== 0 || !json?.result) {
    throw new Error(`GLM file upload failed: HTTP ${res.status}: ${json?.message || text.slice(0, 200)}`);
  }

  const result = json.result;
  const type = glmFileContentTypeFor(file, result);
  const item = {
    file_id: result.file_id,
    file_url: result.file_url,
    file_name: result.file_name || file.filename || 'uploaded-file',
    file_size: result.file_size ?? buffer.length,
    order: 0,
    cover_images: result.cover_images || [],
    url: result.file_url,
    maxReadPercent: result.maxReadPercent || 0,
  };

  if (type === 'image') {
    return {
      type: 'image',
      image: [{
        file_name: item.file_name,
        file_id: item.file_id,
        image_url: result.file_url,
        file_size: item.file_size,
        order: 0,
      }],
    };
  }
  if (type === 'video') {
    return { type: 'video', video: [item] };
  }
  return { type: 'file', file: [item] };
}

async function uploadGlmFiles({ accessToken, attachments = [], assistantId, signal }) {
  const blocks = [];
  for (const [index, file] of (attachments || []).entries()) {
    const block = await uploadGlmFile({ accessToken, file, assistantId, signal });
    const list = block.image || block.video || block.file;
    if (Array.isArray(list)) {
      for (const item of list) item.order = index;
    }
    blocks.push(block);
  }
  return blocks;
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
  const uploadBlocks = options.uploadFiles
    ? await options.uploadFiles({
        accessToken,
        attachments: options.attachments || [],
        assistantId: options.assistantId || DEFAULT_ASSISTANT_ID,
        signal: options.signal,
      })
    : await uploadGlmFiles({
        accessToken,
        attachments: options.attachments || [],
        assistantId: options.assistantId || DEFAULT_ASSISTANT_ID,
        signal: options.signal,
      });

  if (uploadBlocks.length) {
    const target = [...glmMessages].reverse().find(msg => msg.role === 'user') || glmMessages[0];
    if (target) target.content = [...(target.content || []), ...uploadBlocks];
  }

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
    signal: options.signal,
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
        signal: options.signal,
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

// 导出共享的 textFromContent 供 handlers 使用
export { normalizeTools, textFromContent };
