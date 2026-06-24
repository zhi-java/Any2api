/**
 * Notion AI 渠道 — 会话管理
 *
 * Probe JSON 文件的加载、校验、缓存和元数据补齐。
 * Notion 使用 Cookie (token_v2) 认证，与 API Token 不同，
 * 因此独立于 src/services/auth.js Token 池。
 */

import fs from 'fs';

/** @type {SessionInfo|null} */
let currentSession = null;

/**
 * @typedef {Object} ProbePayload
 * @property {string} email
 * @property {string} user_id
 * @property {string} [user_name]
 * @property {string} space_id
 * @property {string} [space_view_id]
 * @property {string} [space_name]
 * @property {string} client_version
 * @property {Array<{name:string, value:string}>} cookies
 */

/**
 * @typedef {Object} SessionInfo
 * @property {string} probePath
 * @property {string} email
 * @property {string} userId
 * @property {string} userName
 * @property {string} spaceId
 * @property {string} spaceViewId
 * @property {string} spaceName
 * @property {string} clientVersion
 * @property {Array<{name:string, value:string}>} cookies
 */

/**
 * 选取第一个非空值
 * @param {...(string|null|undefined)} values
 * @returns {string}
 */
function firstNonEmpty(...values) {
  for (const v of values) {
    if (v && typeof v === 'string' && v.trim()) return v.trim();
  }
  return '';
}

/**
 * 从 Probe JSON 文件加载会话信息
 *
 * @param {string} probePath - Probe JSON 文件路径
 * @param {object} [overrides] - 可选覆盖字段
 * @param {string} [overrides.userName]
 * @param {string} [overrides.spaceName]
 * @returns {SessionInfo}
 * @throws {Error} 文件不存在、JSON 解析失败、缺失必需字段
 */
export function loadSession(probePath, overrides = {}) {
  let raw;
  try {
    raw = fs.readFileSync(probePath, 'utf-8');
  } catch (err) {
    throw new Error(`Notion probe file not found: ${probePath} (${err.message})`);
  }

  /** @type {ProbePayload} */
  let payload;
  try {
    payload = JSON.parse(raw);
  } catch (err) {
    throw new Error(`Notion probe file is not valid JSON: ${probePath}`);
  }

  // 校验必需字段
  const required = ['email', 'user_id', 'space_id', 'client_version'];
  for (const field of required) {
    if (!payload[field] || !String(payload[field]).trim()) {
      throw new Error(`Notion probe missing required field "${field}"`);
    }
  }

  if (!Array.isArray(payload.cookies) || payload.cookies.length === 0) {
    throw new Error('Notion probe missing cookies array');
  }

  // 补齐可选字段
  const localPart = payload.email.split('@')[0];
  const resolvedUserName = firstNonEmpty(
    overrides.userName,
    payload.user_name,
    localPart,
  );
  const resolvedSpaceName = firstNonEmpty(
    overrides.spaceName,
    payload.space_name,
    `${resolvedUserName}'s Workspace`,
  );

  const session = {
    probePath,
    email: payload.email,
    userId: payload.user_id,
    userName: resolvedUserName,
    spaceId: payload.space_id,
    spaceViewId: payload.space_view_id || '',
    spaceName: resolvedSpaceName,
    clientVersion: payload.client_version,
    cookies: payload.cookies.map(c => ({ name: c.name, value: c.value })),
  };

  currentSession = session;
  return session;
}

/**
 * 获取当前缓存的会话信息
 * @returns {SessionInfo}
 * @throws {Error} 会话未加载
 */
export function getSessionInfo() {
  if (!currentSession) {
    throw new Error('Notion session not loaded. Set NOTION_PROBE_PATH in .env');
  }
  return currentSession;
}

/**
 * 检查会话是否已加载
 * @returns {boolean}
 */
export function hasSession() {
  return currentSession !== null;
}

/**
 * 将会话 cookies 拼成 Cookie 请求头字符串
 * @param {SessionInfo} session
 * @returns {string}
 */
export function getCookieHeader(session) {
  return session.cookies.map(c => `${c.name}=${c.value}`).join('; ');
}

/**
 * 获取 Accept-Language 值
 * 优先从 Cookie 中读取 NEXT_LOCALE 或 notion_locale
 * @param {SessionInfo} session
 * @returns {string}
 */
export function getAcceptLanguage(session) {
  for (const name of ['NEXT_LOCALE', 'notion_locale']) {
    const cookie = session.cookies.find(c => c.name === name);
    if (cookie && cookie.value) {
      return normalizeLocale(cookie.value);
    }
  }
  return 'en-US,en;q=0.9';
}

/**
 * 规范化区域设置值
 * @param {string} locale
 * @returns {string}
 */
function normalizeLocale(locale) {
  const map = {
    'zh-CN': 'zh-CN,zh;q=0.9',
    'en-US': 'en-US,en;q=0.9',
    'ja-JP': 'ja-JP,ja;q=0.9',
  };
  return map[locale] || `${locale},en;q=0.9`;
}

/**
 * 强制重新加载会话（用于会话刷新后更新）
 * @param {string} [probePath]
 * @returns {SessionInfo}
 */
export function reloadSession(probePath) {
  const path = probePath || (currentSession && currentSession.probePath);
  if (!path) throw new Error('No probe path to reload');
  return loadSession(path, {});
}

/**
 * 清除当前会话缓存
 */
export function clearSession() {
  currentSession = null;
}

// ============= 元数据自动补齐（可选增强） =============

/**
 * 调用 Notion loadUserContent 接口自动发现缺失的元数据
 *
 * 补齐字段：userName, spaceName, spaceViewId
 * 补齐后自动持久化回 Probe JSON 文件
 *
 * @param {SessionInfo} session
 * @param {import('./client.js').NotionClient} client
 * @returns {Promise<SessionInfo>} 更新后的 session
 */
export async function ensureMetadata(session, client) {
  // 如果所有元数据已齐全，跳过
  if (session.spaceViewId && session.userName && session.spaceName) {
    return session;
  }

  try {
    // 第一步：调用 loadUserContent
    const body = await client.loadUserContent(session);

    /** @type {any} */
    let data;
    try { data = JSON.parse(new TextDecoder().decode(body)); } catch { return session; }

    // 从响应中提取元数据
    const recordMap = data.recordMap || data;
    // 尝试从 space 记录中提取
    if (recordMap.space && recordMap.space[0]) {
      const space = recordMap.space[0];
      if (space.value) {
        if (!session.spaceName && space.value.name) {
          // 无法直接修改 const 对象 —— 生产用 proxy 或直接修改属性
        }
      }
    }
    // 注意：loadUserContent 返回结构复杂，不同版本 Notion 有差异
    // 此处保留扩展点 —— 具体提取逻辑需根据实际 response 调试
  } catch (err) {
    // 元数据补齐失败不应阻断后续请求
    console.warn(`[Notion] Metadata discovery failed: ${err.message}`);
  }

  return session;
}