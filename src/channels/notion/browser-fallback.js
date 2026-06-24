/**
 * Notion AI 渠道 — 浏览器回退
 *
 * 当 HTTP API 请求返回 trust-rule-denied 时，
 * 通过真实浏览器环境执行推理请求以绕过安全规则。
 *
 * 原理：Notion 的 trust-rule 检查请求是否来自真实浏览器环境。
 * 在浏览器页面内执行 fetch() 可提供合法的浏览器上下文。
 */

import { spawn, execSync } from 'child_process';
import { getCookieHeader } from './session.js';
import { buildHeaders, NOTION_UPSTREAM } from './client.js';

const FALLBACK_TIMEOUT_MS = 120_000;
const BROWSER_SETUP_TIMEOUT_MS = 15_000;

/**
 * 在浏览器环境中执行 runInferenceTranscript
 *
 * @param {import('./session.js').SessionInfo} session
 * @param {object} payload - runInferenceTranscript 请求体
 * @param {number} [timeoutMs] - 超时时间
 * @returns {Promise<string>} NDJSON 文本
 */
export async function browserFallback(session, payload, timeoutMs = FALLBACK_TIMEOUT_MS) {
  const cookie = getCookieHeader(session);
  const url = `${NOTION_UPSTREAM.baseURL}/api/v3/runInferenceTranscript`;
  const headers = buildHeaders(session, {
    accept: 'application/x-ndjson',
    referer: NOTION_UPSTREAM.aiURL,
  });
  delete headers['cookie']; // 浏览器会自动携带

  const body = JSON.stringify(payload);

  // 1. 关闭可能遗留的旧 session
  try { execSync('agent-browser close --all', { timeout: 5000, stdio: 'ignore' }); } catch {}

  // 2. 打开浏览器并设置 cookie
  console.log('[Notion Browser] Launching browser...');
  try {
    execSync(
      `agent-browser open "${NOTION_UPSTREAM.baseURL}" --cookie "${escapeShell(cookie)}"`,
      { timeout: BROWSER_SETUP_TIMEOUT_MS, stdio: 'pipe' }
    );
  } catch (err) {
    throw new Error(`Browser launch failed: ${err.message}`);
  }

  // 3. 导航到 /ai 页面，确保在正确的页面上下文中
  try {
    execSync(
      `agent-browser navigate "${NOTION_UPSTREAM.aiURL}"`,
      { timeout: BROWSER_SETUP_TIMEOUT_MS, stdio: 'pipe' }
    );
  } catch (err) {
    execSync('agent-browser close --all', { timeout: 5000, stdio: 'ignore' });
    throw new Error(`Browser navigate failed: ${err.message}`);
  }

  // 等待页面加载
  await sleep(3000);

  // 4. 从浏览器页面内发起 fetch 请求
  const jsCode = `
    (async () => {
      try {
        const r = await fetch(${JSON.stringify(url)}, {
          method: 'POST',
          headers: ${JSON.stringify(headers)},
          body: ${JSON.stringify(body)}
        });
        if (!r.ok) {
          return '__ERROR__:' + r.status + ':' + (await r.text());
        }
        return await r.text();
      } catch(e) {
        return '__ERROR__:' + e.message;
      }
    })()
  `;

  console.log('[Notion Browser] Executing fetch in browser context...');

  try {
    const result = execSync(
      `agent-browser eval ${JSON.stringify(jsCode)}`,
      { timeout: timeoutMs, encoding: 'utf-8', stdio: 'pipe' }
    );

    const output = result.trim();

    // 检查错误
    if (output.startsWith('__ERROR__:')) {
      const parts = output.split(':');
      const errMsg = parts.slice(1).join(':');
      throw new Error(`Browser fetch error: ${errMsg}`);
    }

    if (!output || output.length < 10) {
      throw new Error('Browser returned empty response');
    }

    return output;
  } catch (err) {
    if (err.message.includes('Browser fetch error')) throw err;
    throw new Error(`Browser eval failed: ${err.message}`);
  } finally {
    // 5. 关闭浏览器
    try { execSync('agent-browser close --all', { timeout: 5000, stdio: 'ignore' }); } catch {}
  }
}

function escapeShell(str) {
  return str.replace(/"/g, '\\"').replace(/\n/g, ' ');
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * 判断错误是否为 trust-rule-denied
 * @param {Error} err
 * @returns {boolean}
 */
export function isTrustRuleDenied(err) {
  return err.message && (
    err.message.includes('trust-rule-denied') ||
    err.message.includes('trust rule denied')
  );
}

/**
 * 判断错误是否为 Notion 400 ValidationError
 * @param {Error} err
 * @returns {boolean}
 */
export function isValidationError(err) {
  return err.message && err.message.includes('ValidationError');
}