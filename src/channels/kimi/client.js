import { buildToolInstructions, normalizeTools, textFromContent } from '../../utils/response-utils.js';
import { resolveUploadableBytes } from '../../utils/message-files.js';

const BASE_URL = 'https://www.kimi.com';
const CHAT_URL = `${BASE_URL}/apiv2/kimi.gateway.chat.v1.ChatService/Chat`;
const FILE_UPLOAD_URL = `${BASE_URL}/apiv2-files/file/upload`;
const SCENARIO_K2_6 = 'SCENARIO_K2D5';
const DEFAULT_TEXT_ATTACHMENT_THRESHOLD_BYTES = 450000;

function getTextAttachmentThresholdBytes() {
  const configured = Number.parseInt(process.env.KIMI_TEXT_ATTACHMENT_THRESHOLD_BYTES || '', 10);
  return Number.isFinite(configured) && configured > 0
    ? configured
    : DEFAULT_TEXT_ATTACHMENT_THRESHOLD_BYTES;
}

function compactSnippet(text, maxLength = 200) {
  return String(text || '').replace(/\s+/g, ' ').trim().slice(0, maxLength);
}

export function createConnectJsonFrame(payload) {
  const data = Buffer.from(JSON.stringify(payload));
  const header = Buffer.alloc(5);
  header[0] = 0;
  header.writeUInt32BE(data.length, 1);
  return Buffer.concat([header, data]);
}

function kimiHeaders(token) {
  return {
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/connect+json',
    Accept: 'application/connect+json',
    'Connect-Protocol-Version': '1',
    Origin: BASE_URL,
    Referer: `${BASE_URL}/`,
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36',
  };
}

function kimiFileUploadHeaders(token) {
  return {
    Authorization: `Bearer ${token}`,
    Origin: BASE_URL,
    Referer: `${BASE_URL}/`,
    'x-msh-platform': 'web',
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36',
  };
}

function shouldUploadPromptAsTextFile(prompt) {
  return Buffer.byteLength(String(prompt || ''), 'utf8') > getTextAttachmentThresholdBytes();
}

async function uploadKimiFile({ token, bytes, filename, mimeType, signal, tokenManager }) {
  const form = new FormData();
  const blob = new Blob([bytes], { type: mimeType || 'application/octet-stream' });
  form.append('file', blob, filename || 'uploaded-file');

  const res = await fetch(FILE_UPLOAD_URL, {
    method: 'POST',
    headers: kimiFileUploadHeaders(token),
    body: form,
    signal,
  });

  const text = await res.text();
  if (!res.ok) {
    tokenManager?.reportTokenFailure(token, `HTTP ${res.status}: ${compactSnippet(text)}`);
    throw new Error(`Kimi file upload failed: HTTP ${res.status}: ${compactSnippet(text)}`);
  }

  let json;
  try {
    json = JSON.parse(text);
  } catch {
    tokenManager?.reportTokenFailure(token, `Invalid upload response: ${compactSnippet(text)}`);
    throw new Error(`Kimi file upload failed: invalid JSON response: ${compactSnippet(text)}`);
  }

  const fileId = json?.file?.id;
  if (!fileId) {
    tokenManager?.reportTokenFailure(token, `Missing upload file id: ${compactSnippet(text)}`);
    throw new Error(`Kimi file upload failed: missing file id: ${compactSnippet(text)}`);
  }

  return fileId;
}

async function uploadKimiTextFile({ token, prompt, signal, tokenManager }) {
  return uploadKimiFile({
    token,
    bytes: Buffer.from(String(prompt || ''), 'utf8'),
    filename: 'any2api-long-input.txt',
    mimeType: 'text/plain;charset=utf-8',
    signal,
    tokenManager,
  });
}

async function uploadKimiAttachment({ token, file, signal, tokenManager }) {
  const { buffer, mimeType } = await resolveUploadableBytes(file);
  return uploadKimiFile({
    token,
    bytes: buffer,
    filename: file.filename,
    mimeType: mimeType || file.mimeType,
    signal,
    tokenManager,
  });
}

async function buildKimiMessageBlocks({ token, prompt, attachments = [], signal, tokenManager }) {
  const blocks = [];

  if (!shouldUploadPromptAsTextFile(prompt)) {
    blocks.push({ message_id: '', text: { content: prompt } });
  } else {
    const fileId = await uploadKimiTextFile({ token, prompt, signal, tokenManager });
    blocks.push(
      {
        message_id: '',
        text: {
          content: '用户的完整输入内容已作为 txt 附件上传。请读取附件中的完整内容，并按附件内容直接回答用户请求。',
        },
      },
      {
        message_id: '',
        file: {
          id: fileId,
          status: 3,
          fail_reason: '',
        },
      },
    );
  }

  for (const file of attachments || []) {
    const fileId = await uploadKimiAttachment({ token, file, signal, tokenManager });
    blocks.push({
      message_id: '',
      file: {
        id: fileId,
        status: 3,
        fail_reason: '',
      },
    });
  }

  return blocks;
}

export function buildKimiMessages(messages, tools = [], toolChoice = 'auto') {
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

  return parts.filter(Boolean).join('\n\n');
}

export async function kimiChatCompletion({
  token,
  prompt,
  attachments = [],
  scenario = SCENARIO_K2_6,
  thinkingEnabled = false,
  signal,
  tokenManager,
}) {
  const blocks = await buildKimiMessageBlocks({ token, prompt, attachments, signal, tokenManager });
  const body = {
    scenario,
    tools: [
      { type: 'TOOL_TYPE_SEARCH', search: {} },
      { type: 'TOOL_TYPE_CRON_JOB' },
    ],
    message: {
      role: 'user',
      blocks,
      scenario,
    },
    options: {
      thinking: Boolean(thinkingEnabled),
      enable_plugin: false,
    },
  };

  const res = await fetch(CHAT_URL, {
    method: 'POST',
    headers: kimiHeaders(token),
    body: createConnectJsonFrame(body),
    signal,
  });

  if (!res.ok) {
    const text = await res.text();
    tokenManager?.reportTokenFailure(token, `HTTP ${res.status}: ${compactSnippet(text)}`);
    throw new Error(`Kimi completion failed: HTTP ${res.status}: ${compactSnippet(text)}`);
  }

  tokenManager?.reportTokenSuccess(token);
  return res.body;
}

export { SCENARIO_K2_6, uploadKimiFile };
