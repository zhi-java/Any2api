/**
 * Notion AI 渠道 — TLS 指纹回退
 *
 * 替代真实的浏览器回退方案。当 HTTP API 请求返回 trust-rule-denied 时，
 * 使用 tls-client-node 模拟 Chrome 的 TLS 指纹发送请求，绕过 Notion 的安全检测。
 *
 * 实现原理：
 *   Go 参考代码使用 surf 库 (github.com/enetx/surf) 的 Impersonate().Chrome()
 *   来模拟 Chrome TLS 指纹。本模块使用 tls-client-node 的 chrome_145 ClientIdentifier
 *   实现相同的效果，无需依赖真实浏览器环境。
 *
 * 参考：
 *   docs/参考/app/notion_client_browser_transport.go
 *   docs/参考/app/notion_client_surf_transport.go
 */

import { buildHeaders, NOTION_UPSTREAM } from './client.js';
import { fileURLToPath } from 'url';
import path from 'path';

// ============= 单例 TLS 客户端 =============

/** @type {import('tls-client-node').TLSClient | null} */
let tlsClientInstance = null;

/** 当前模块目录（ESM 中替代 __dirname） */
const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** tls-client 原生 DLL 路径 */
const TLS_CLIENT_DLL = path.resolve(
  __dirname, '..', '..', '..',
  'node_modules', 'tls-client-node', 'bin', 'tls-client-windows-64-1.15.1.dll'
);

const MAX_RETRIES = 2;

/**
 * 获取或创建单例 TLS 客户端
 */
async function getTlsClient() {
  if (tlsClientInstance) return tlsClientInstance;
  const { TLSClient } = await import('tls-client-node');
  tlsClientInstance = new TLSClient({
    nativeLibraryPath: TLS_CLIENT_DLL,
    runtimeMode: 'native',
  });
  return tlsClientInstance;
}

// ============= TLS 指纹回退 =============

/**
 * 使用 tls-client-node（Chrome 145 TLS 指纹）执行 runInferenceTranscript
 *
 * @param {import('./session.js').SessionInfo} session
 * @param {object} payload - runInferenceTranscript 请求体
 * @param {number} [timeoutMs] - 超时时间
 * @returns {Promise<string>} NDJSON 文本
 */
export async function browserFallback(session, payload, timeoutMs = 120_000) {
  const url = `${NOTION_UPSTREAM.baseURL}/api/v3/runInferenceTranscript`;

  // 构造请求头（含 cookie 认证信息）
  const headers = buildHeaders(session, {
    accept: 'application/x-ndjson',
    referer: NOTION_UPSTREAM.aiURL,
  });
  // cookie 已包含在 buildHeaders 返回的 headers 中，
  // 保留在 headers 里而非通过 tls-client-node 的 cookies 参数传递，
  // 因为独立测试验证了 header 方式工作正常。

  // 代理配置
  const proxyUrl = process.env.HTTPS_PROXY || process.env.https_proxy
    || process.env.HTTP_PROXY || process.env.http_proxy || '';

  const client = await getTlsClient();

  let lastError;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    if (attempt > 0) {
      console.log(`[Notion TLS] Retry attempt ${attempt}/${MAX_RETRIES}...`);
      await new Promise(r => setTimeout(r, attempt * 1500));
    }

    try {
      console.log(`[Notion TLS] Sending request with Chrome 145 TLS fingerprint (attempt ${attempt + 1})...`);

      const response = await client.request(url, {
        clientIdentifier: 'chrome_145',
        method: 'POST',
        headers,
        body: JSON.stringify(payload),
        proxy: proxyUrl,
        timeoutSeconds: Math.ceil(timeoutMs / 1000),
        followRedirects: false,
        // 使用 isByteResponse 避免 koffi 在 Windows 上的 UTF-8 编码问题
        // tls-client-node 的原生 DLL 通过 koffi 返回字符串时，UTF-8 多字节
        // 字符被当成了 Latin-1 解码。isByteResponse 让 body 以 base64
        // （纯 ASCII）返回，我们手动解码为 UTF-8。
        isByteResponse: true,
      });

      if (!response || typeof response.status !== 'number') {
        throw new Error(`Invalid response: ${JSON.stringify(response)}`);
      }

      // 从 base64 Data URL 解码响应体（避免 koffi 编码损坏）
      const rawBody = typeof response.body === 'string'
        ? response.body
        : JSON.stringify(response.body);

      let text;
      if (typeof rawBody === 'string' && rawBody.startsWith('data:')) {
        // data:application/octet-stream;base64,<base64>
        const base64 = rawBody.split(',')[1];
        if (!base64) throw new Error('Missing base64 body in TLS response');
        text = new TextDecoder('utf-8').decode(Buffer.from(base64, 'base64'));
      } else {
        // 降级：直接使用 body（可能编码损坏，但比报错好）
        text = rawBody;
        console.warn('[Notion TLS] Response body is not a data URL, encoding may be corrupted');
      }

      // 记录响应前 200 字节用于调试
      console.log(`[Notion TLS] Response status=${response.status} body_len=${text.length} preview=${text.substring(0, 200)}`);

      if (response.status < 200 || response.status >= 300) {
        throw new Error(
          `Notion API ${response.status} (TLS fallback): ${(text || response.statusText).substring(0, 500)}`
        );
      }

      if (!text || text.length < 10) {
        throw new Error(`Empty response from Notion via TLS fallback (len=${text.length})`);
      }

      // 传输层检查：响应是否以 JSON/NDJSON 开头（非 HTML 挑战页）
      const trimmed = text.trim();
      if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) {
        throw new Error(`TLS fallback returned non-NDJSON content: ${trimmed.substring(0, 200)}`);
      }

      console.log(`[Notion TLS] Success: ${text.length} bytes`);

      // 清理客户端资源
      try {
        await client.destroyAll();
        tlsClientInstance = null;
      } catch {}

      return text;

    } catch (err) {
      lastError = err;
      console.error(`[Notion TLS] Attempt ${attempt + 1} failed: ${err.message}`);

      // 连接问题—重建客户端
      if (err.message.includes('EOF') || err.message.includes('connection reset') || err.message.includes('transport error')) {
        try {
          await client.destroyAll();
          tlsClientInstance = null;
        } catch {}
        continue;
      }

      // 非重试性错误
      throw err;
    }
  }

  throw lastError || new Error('All TLS fallback attempts failed');
}

/**
 * 判断错误是否为 trust-rule-denied
 */
export function isTrustRuleDenied(err) {
  return err.message && (
    err.message.includes('trust-rule-denied') ||
    err.message.includes('trust rule denied')
  );
}

/**
 * 判断错误是否为 Notion 400 ValidationError
 */
export function isValidationError(err) {
  return err.message && err.message.includes('ValidationError');
}