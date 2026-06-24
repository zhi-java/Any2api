/**
 * Notion AI 渠道 — HTTP 请求伪造客户端
 *
 * 核心职责：
 * 1. 构造与 Chrome 浏览器一致的请求头签名（防检测）
 * 2. 按端点策略动态选择 Referer
 * 3. 封装 Notion 内部 API 调用
 *
 * Notion API Base URL: https://www.notion.so
 */

import { getDispatcher } from '../../utils/headers.js';
import { getCookieHeader, getAcceptLanguage } from './session.js';

// ============= Chrome 145 浏览器指纹 =============

const CHROME_VERSION = '145';
const UA = `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${CHROME_VERSION}.0.0.0 Safari/537.36`;

const SEC_CH_UA = `"Google Chrome";v="${CHROME_VERSION}", "Not?A_Brand";v="8", "Chromium";v="${CHROME_VERSION}"`;

// ============= 上游配置 =============

export const NOTION_UPSTREAM = {
  baseURL: 'https://www.notion.so',
  originURL: 'https://www.notion.so',
  homeURL: 'https://www.notion.so',
  aiURL: 'https://www.notion.so/ai',
  endpoints: {
    runInference: '/api/v3/runInferenceTranscript',
    loadUserContent: '/api/v3/loadUserContent',
    getSpacesInitial: '/api/v3/getSpacesInitial',
    saveTransactions: '/api/v3/saveTransactionsFanout',
    syncRecordValues: '/api/v3/syncRecordValuesSpaceInitial',
    getTranscripts: '/api/v3/getInferenceTranscriptsForUser',
    getUploadFileUrl: '/api/v3/getUploadFileUrl',
  },
};

// ============= 请求头构建 =============

/**
 * 构造伪造的浏览器请求头
 *
 * @param {import('./session.js').SessionInfo} session
 * @param {object} [opts]
 * @param {string} [opts.accept] - Accept 头（默认 application/json）
 * @param {string} [opts.referer] - Referer 头
 * @param {string} [opts.contentType] - Content-Type（默认 application/json）
 * @returns {Record<string, string>}
 */
export function buildHeaders(session, opts = {}) {
  const accept = opts.accept || 'application/json';
  const referer = opts.referer || NOTION_UPSTREAM.aiURL;
  const contentType = opts.contentType || 'application/json';

  return {
    // 核心认证
    'cookie': getCookieHeader(session),
    'x-notion-active-user-header': session.userId,
    'x-notion-space-id': session.spaceId,

    // 客户端身份
    'notion-client-version': session.clientVersion,
    'notion-audit-log-platform': 'web',

    // HTTP 标准头
    'accept': accept,
    'content-type': contentType,
    'accept-language': getAcceptLanguage(session),

    // 同源策略
    'origin': NOTION_UPSTREAM.originURL,
    'referer': referer,

    // 浏览器特征（关键！）
    'user-agent': UA,
    'sec-ch-ua': SEC_CH_UA,
    'sec-ch-ua-mobile': '?0',
    'sec-ch-ua-platform': '"Windows"',

    // Fetch 元数据
    'sec-fetch-dest': 'empty',
    'sec-fetch-mode': 'cors',
    'sec-fetch-site': 'same-origin',
  };
}

// ============= Referer 策略 =============

/**
 * 根据端点和请求体动态选择 Referer
 *
 * 不同的 Notion API 端点需要不同的 Referer：
 * - runInferenceTranscript（新对话）→ /ai
 * - runInferenceTranscript（续接）→ /chat?t=THREAD_ID&wfv=chat
 * - loadUserContent / getSpacesInitial → 首页
 *
 * @param {string} url - 请求 URL
 * @param {object} [payload] - 请求体
 * @returns {string}
 */
export function resolveReferer(url, payload) {
  if (url.includes('runInferenceTranscript')) {
    // 新对话 vs 续接
    if (payload && payload.createThread) {
      return NOTION_UPSTREAM.aiURL;
    }
    // 续接已有 thread
    const threadId = payload?.threadId || payload?.id || '';
    if (threadId) {
      return chatReferer(threadId);
    }
    return NOTION_UPSTREAM.aiURL;
  }

  if (url.includes('saveTransactionsFanout') || url.includes('syncRecordValues')) {
    const threadId = payload?.threadId || '';
    return threadId ? chatReferer(threadId) : NOTION_UPSTREAM.aiURL;
  }

  if (url.includes('markInferenceTranscriptSeen') || url.includes('getInferenceTranscriptsForUser')) {
    return NOTION_UPSTREAM.aiURL;
  }

  // 默认
  return NOTION_UPSTREAM.homeURL;
}

/**
 * 生成 chat 页面 Referer
 * @param {string} threadId - UUID
 * @returns {string}
 */
function chatReferer(threadId) {
  const clean = threadId.replace(/-/g, '');
  if (!clean) return NOTION_UPSTREAM.aiURL;
  return `${NOTION_UPSTREAM.baseURL}/chat?t=${clean}&wfv=chat`;
}

// ============= HTTP 客户端 =============

/**
 * 带代理支持的 fetch 封装
 * 复用 src/utils/headers.js 的代理逻辑
 *
 * @param {string} url
 * @param {RequestInit} options
 * @returns {Promise<Response>}
 */
async function proxiedFetch(url, options = {}) {
  const dispatcher = await getDispatcher();
  if (dispatcher) {
    options.dispatcher = dispatcher;
  }
  return fetch(url, options);
}

/**
 * Notion AI HTTP 客户端
 *
 * 封装所有 Notion 内部 API 请求，自动处理：
 * - 请求头伪造
 * - Referer 策略
 * - Content-Type/Accept 联动
 */
export class NotionClient {
  /**
   * @param {import('./session.js').SessionInfo} session
   */
  constructor(session) {
    this.session = session;
  }

  /**
   * AI 推理核心 —— 发送 prompt 给 Notion AI，返回 NDJSON 流
   *
   * @param {object} payload - runInferenceTranscript 请求体
   * @returns {Promise<Response>} fetch Response（body 为 ReadableStream）
   */
  async runInferenceTranscript(payload) {
    const url = `${NOTION_UPSTREAM.baseURL}${NOTION_UPSTREAM.endpoints.runInference}`;
    const referer = resolveReferer(url, payload);

    const headers = buildHeaders(this.session, {
      accept: 'application/x-ndjson',
      referer,
      contentType: 'application/json',
    });

    const body = JSON.stringify(payload);

    const response = await proxiedFetch(url, {
      method: 'POST',
      headers,
      body,
    });

    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw new NotionClientError(
        `Notion API ${response.status}: ${text || response.statusText}`,
        { status: response.status, body: text },
      );
    }

    return response;
  }

  /**
   * 加载用户和工作空间信息
   *
   * @returns {Promise<Buffer>} 响应体
   */
  async loadUserContent() {
    const url = `${NOTION_UPSTREAM.baseURL}${NOTION_UPSTREAM.endpoints.loadUserContent}`;

    const headers = buildHeaders(this.session, {
      accept: 'application/json',
      referer: NOTION_UPSTREAM.homeURL,
    });

    const response = await proxiedFetch(url, {
      method: 'POST',
      headers,
      body: '{}',
    });

    if (!response.ok) {
      throw new NotionClientError(
        `Notion loadUserContent failed: ${response.status}`,
        { status: response.status },
      );
    }

    return Buffer.from(await response.arrayBuffer());
  }

  /**
   * 获取上传文件 URL
   *
   * @param {object} fileInfo - { name, contentType, sizeBytes }
   * @returns {Promise<object>} upload URL 和字段
   */
  async getUploadFileUrl(fileInfo) {
    const url = `${NOTION_UPSTREAM.baseURL}${NOTION_UPSTREAM.endpoints.getUploadFileUrl}`;

    const headers = buildHeaders(this.session, {
      accept: 'application/json',
      referer: NOTION_UPSTREAM.aiURL,
    });

    const response = await proxiedFetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(fileInfo),
    });

    if (!response.ok) {
      throw new NotionClientError(
        `Notion getUploadFileUrl failed: ${response.status}`,
        { status: response.status },
      );
    }

    return response.json();
  }
}

// ============= 错误类型 =============

/**
 * Notion 客户端错误
 */
export class NotionClientError extends Error {
  /**
   * @param {string} message
   * @param {object} [details]
   * @param {number} [details.status]
   * @param {string} [details.body]
   */
  constructor(message, details = {}) {
    super(message);
    this.name = 'NotionClientError';
    this.status = details.status || 0;
    this.body = details.body || '';
  }
}