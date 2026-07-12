import { loadEnvironment } from '../utils/env.js';
import { getConfig, updateChannelConfig } from './config-store.js';
import { invalidateByTokenPrefix } from './conversation.js';
import { invalidateTokenSessions as invalidateSessionCache } from './session.js';

loadEnvironment();

const BASE_URL = 'https://chat.deepseek.com';

function maxConcurrentPerToken() {
  return getConfig().deepseek.maxConcurrentPerToken;
}

function tokenDeadThreshold() {
  return getConfig().deepseek.tokenDeadThreshold;
}

// Multi-token support: DS_TOKENS=token1,token2,token3 (comma-separated)
// Fallback: DS_TOKEN=single_token
// Account support: DS_ACCOUNTS=email1:pass1,email2:pass2 (auto-login to refresh tokens)
export function loadTokens() {
  const tokensStr = process.env.DS_TOKENS?.trim();
  if (tokensStr) {
    return tokensStr.split(',').map(t => t.trim()).filter(Boolean);
  }
  const single = process.env.DS_TOKEN?.trim();
  if (single) return [single];
  return [];
}

export function loadAccounts() {
  const accountsStr = process.env.DS_ACCOUNTS?.trim();
  if (!accountsStr) return [];
  return accountsStr.split(',').map(entry => {
    const [email, ...passParts] = entry.trim().split(':');
    const password = passParts.join(':');
    return email && password ? { email, password } : null;
  }).filter(Boolean);
}

const tokens = loadTokens();
const accounts = loadAccounts();

function generateDeviceId() {
  const bytes = new Uint8Array(48);
  for (let i = 0; i < 48; i++) bytes[i] = Math.floor(Math.random() * 256);
  return Buffer.from(bytes).toString('base64').replace(/=/g, '') + '==';
}

// DS_ACCOUNTS_EXTENDED=email:password:token_prefix — links existing tokens to accounts
function loadAccountTokens() {
  const extStr = process.env.DS_ACCOUNTS_EXTENDED?.trim();
  if (!extStr) return [];
  return extStr.split(',').map(entry => {
    const [email, ...rest] = entry.trim().split(':');
    if (rest.length >= 2) {
      const tokenPrefix = rest.pop();
      const password = rest.join(':');
      return email && password && tokenPrefix ? { email, password, tokenPrefix } : null;
    }
    return null;
  }).filter(Boolean);
}

const accountTokenMap = loadAccountTokens();

// Token metadata: { token, email, password, visionCapable, lastUsed, errorCount, activeRequests, dead }
const tokenPool = tokens.map(t => ({
  token: t,
  email: null,
  password: null,
  visionCapable: null,
  lastUsed: 0,
  errorCount: 0,
  activeRequests: 0,
  dead: false,
}));

// Link existing tokens to accounts via token prefix
for (const entry of tokenPool) {
  if (!entry.token) continue;
  const prefix = entry.token.slice(0, 12);
  const match = accountTokenMap.find(a => a.tokenPrefix === prefix);
  if (match) {
    entry.email = match.email;
    entry.password = match.password;
  }
}

// Create pool entries for accounts without matching tokens (will login on init)
for (const acct of accounts) {
  const alreadyLinked = tokenPool.some(t => t.email === acct.email);
  if (!alreadyLinked) {
    tokenPool.push({
      token: null,
      email: acct.email,
      password: acct.password,
      visionCapable: null,
      lastUsed: 0,
      errorCount: 0,
      activeRequests: 0,
      dead: false,
    });
  }
}

function createTokenEntry({ token = null, email = null, password = null, visionCapable = null } = {}) {
  return {
    token,
    email,
    password,
    visionCapable,
    lastUsed: 0,
    errorCount: 0,
    activeRequests: 0,
    dead: false,
  };
}

export function syncTokenPoolFromConfig() {
  const { deepseek } = getConfig();
  const previous = new Map(tokenPool.filter(entry => entry.token).map(entry => [entry.token, entry]));
  tokenPool.splice(0, tokenPool.length);

  for (const token of deepseek.tokens) {
    const prior = previous.get(token);
    tokenPool.push(prior ? { ...prior, activeRequests: 0 } : createTokenEntry({ token }));
  }

  for (const account of deepseek.accounts) {
    const alreadyLinked = tokenPool.some(entry => entry.email === account.email);
    if (!alreadyLinked) {
      tokenPool.push(createTokenEntry({ email: account.email, password: account.password }));
    }
  }
}

import { loginHeaders, getHeaders, getDeviceId, proxiedFetch, getDeviceIdForToken } from '../utils/headers.js';

async function login(email, password) {
  // Use a fresh deviceId for login — real browser gets it from portal101.cn device fingerprint
  const loginDeviceId = 'B' + generateDeviceId();

  const res = await proxiedFetch(`${BASE_URL}/api/v0/users/login`, {
    method: 'POST',
    headers: loginHeaders(),
    body: JSON.stringify({ email, mobile: '', password, area_code: '', device_id: loginDeviceId, os: 'web' }),
  });

  // AWS WAF returns 202 with empty body — can't login from this IP
  if (res.status === 202) {
    throw new Error(
      `WAF challenge (202) — DeepSeek 登录被防火墙拦截。\n`
      + `请通过浏览器登录 chat.deepseek.com，从浏览器开发者工具 Application → Local Storage 或 Network 请求中获取 token，`
      + `然后 ① 配置到 DS_TOKENS 环境变量 或 ② 在后台"上游凭据"页面以 Token 方式添加 DeepSeek 凭据。\n`
      + `如果必须使用账号自动登录，可尝试设置 HTTPS_PROXY 更换出口 IP。`
    );
  }

  const text = await res.text();
  if (!text) throw new Error('Empty response from login endpoint');

  const json = JSON.parse(text);
  if (json.code !== 0) {
    console.warn(`[DeepSeek] Login failed for ${email}: code=${json.code} msg=${json.msg || 'no msg'} body=${text.slice(0, 400)}`);
    throw new Error(`Login failed for ${email}: ${json.msg || JSON.stringify(json)}`);
  }

  const bizCode = json.data?.biz_code;
  if (bizCode === 10) {
    throw new Error(`Account banned: ${email}`);
  }
  if (bizCode === 11) {
    throw new Error(`Account requires verification: ${email}`);
  }

  // DeepSeek 的 token 可能是多种格式：JWT（eyJ...）、sk-、纯 hex 等。
  // 优先从已知路径提取，如果都不命中则遍历整个 JSON 搜索 token-like 字符串。
  const token =
    json.data?.biz_data?.user?.token
    || json.data?.biz_data?.token
    || json.data?.token
    || json.data?.user?.token;

  if (!token) {
    // Fallback: deep-scan the entire parsed response for a plausible bearer token.
    // This handles upstream API response-format changes without code changes.
    const jsonStr = JSON.stringify(json);
    // Try common alternative field names
    const tokenCandidates = [
      json.data?.biz_data?.user,
      json.data?.biz_data?.access_token,
      json.data?.biz_data?.session_token,
      json.data?.biz_data?.jwt,
      json.data?.user_id,
      json.data?.biz_data?.token,
      // Some responses put user/token at root level
      typeof json.data === 'string' ? json.data : null,
      typeof json.data?.user === 'string' ? json.data.user : null,
    ];
    const found = tokenCandidates.find(c => c && typeof c === 'string' && c.length > 20);
    if (found) {
      console.log(`[DeepSeek] Login token extracted via alternate field for ${email}`);
      return found;
    }
    // Last resort: try multiple regex patterns to find any token-like value in the response.
    // Patterns cover: JWT (with dots), sk- prefixed tokens, base64, hex strings.
    const regexes = [
      /"(?:sk-|)[A-Za-z0-9_.-]{36,}"/,        // JWT and sk- tokens (quoted)
      /"(?:(?:sk-)?[A-Za-z0-9+/]{40,}(?:=|))"/, // base64 with possible padding
      /"(?:sk-|)[A-Za-z0-9_-]{36,}"/,           // alphanumeric only (no dots)
    ];
    for (const re of regexes) {
      const m2 = jsonStr.match(re);
      if (m2) {
        console.log(`[DeepSeek] Login token extracted via regex (${re.source}) for ${email}`);
        return m2[0].replace(/"/g, '');
      }
    }
    const responseSample = jsonStr.slice(0, 600);
    console.warn(`[DeepSeek] Login response for ${email}: sample=${responseSample}`);
    throw new Error(`Login succeeded but no token found in response. Check server logs for response structure.`);
  }
  return token;
}

async function checkVisionCapability(token) {
  try {
    const res = await proxiedFetch(`${BASE_URL}/api/v0/client/settings?did=${getDeviceId()}&scope=model`, {
      headers: await getHeaders(token),
    });
    const json = await res.json();
    const configs = json.data?.biz_data?.settings?.model_configs?.value || [];
    const visionConfig = configs.find(c => c.model_type === 'vision');
    if (visionConfig) {
      return visionConfig.switchable === true;
    }
    return false;
  } catch {
    return null;
  }
}

// Check if a token is still valid — uses /users/current which actually validates the token
// (unlike /client/settings which returns code:0 even for invalid tokens)
async function validateToken(token) {
  try {
    const res = await proxiedFetch(`${BASE_URL}/api/v0/users/current`, {
      headers: await getHeaders(token),
    });
    const json = await res.json();
    return json.code === 0;
  } catch {
    return false;
  }
}

// Refresh a dead token entry — login if account credentials exist
async function refreshToken(entry) {
  if (!entry.password) return false;
  try {
    const newToken = await login(entry.email, entry.password);
    entry.token = newToken;
    entry.errorCount = 0;
    entry.dead = false;
    const vision = await checkVisionCapability(newToken);
    entry.visionCapable = vision;
    console.log(`  Refreshed token for ${entry.email}: ${newToken.slice(0, 12)}... vision=${vision}`);
    return true;
  } catch (err) {
    console.warn(`  Refresh failed for ${entry.email}: ${err.message}`);
    // If account is banned, mark dead permanently
    if (err.message.includes('banned')) {
      entry.dead = true;
      entry.errorCount = tokenDeadThreshold();
    }
    return false;
  }
}

export async function initTokenPool() {
  syncTokenPoolFromConfig();
  const config = getConfig().deepseek;
  console.log(`Token pool: ${tokenPool.length} entries (${config.tokens.length} tokens + ${config.accounts.length} accounts), max ${maxConcurrentPerToken()} concurrent each`);
  if (config.tokens.length === 0 && config.accounts.length === 0) {
    console.warn('No DeepSeek credentials configured; requests will fail until configured from the admin UI or config file.');
  }

  // Always log in accounts that have no token yet — startup must produce usable tokens.
  for (let i = tokenPool.length - 1; i >= 0; i--) {
    const entry = tokenPool[i];
    if (!entry.token && entry.password) {
      console.log(`  Logging in ${entry.email}...`);
      const ok = await refreshToken(entry);
      if (!ok && entry.dead) {
        console.log(`  Removing banned/failed account entry for ${entry.email}`);
        tokenPool.splice(i, 1);
      }
    }
  }

  // Remove stale entries that have neither token nor password (shouldn't happen but guard).
  for (let i = tokenPool.length - 1; i >= 0; i--) {
    if (!tokenPool[i].token && !tokenPool[i].password) {
      console.log(`  Removing stale NONE entry at index ${i}`);
      tokenPool.splice(i, 1);
    }
  }

  if (!config.validateOnStartup) {
    console.log('DeepSeek startup validation skipped; accounts already logged in above. Use the admin test button to validate individual tokens.');
    for (const entry of tokenPool) {
      if (entry.token && !entry.dead) {
        const vision = await checkVisionCapability(entry.token);
        entry.visionCapable = vision;
      }
    }
    const alive = tokenPool.filter(t => !t.dead).length;
    console.log(`Pool ready: ${alive}/${tokenPool.length} tokens alive`);
    return;
  }

  // Validate existing tokens, mark dead ones (auto-refresh if account linked)
  for (const entry of tokenPool) {
    if (entry.token) {
      const valid = await validateToken(entry.token);
      if (!valid) {
        console.log(`  ${entry.token.slice(0, 12)}... INVALID — ${entry.password ? 'attempting refresh' : 'no account to refresh'}`);
        if (entry.password) {
          const ok = await refreshToken(entry);
          if (ok) {
            const dupIdx = tokenPool.findIndex(t => t !== entry && t.email === entry.email && !t.token);
            if (dupIdx !== -1) {
              console.log(`  Removing duplicate account entry for ${entry.email}`);
              tokenPool.splice(dupIdx, 1);
            }
          }
        } else {
          entry.dead = true;
          entry.errorCount = tokenDeadThreshold();
        }
      }
    }
  }

  for (const entry of tokenPool) {
    if (entry.token && !entry.dead) {
      const vision = await checkVisionCapability(entry.token);
      entry.visionCapable = vision;
      const label = vision === true ? 'vision=YES' : vision === false ? 'vision=NO' : 'vision=UNKNOWN';
      console.log(`  ${entry.token.slice(0, 12)}... ${label} ${entry.email ? `(${entry.email})` : ''}`);
    }
  }

  const alive = tokenPool.filter(t => !t.dead).length;
  console.log(`Pool ready: ${alive}/${tokenPool.length} tokens alive`);
  persistTokensToConfig();
}

export function acquireToken(preferVision = false) {
  const liveCandidates = tokenPool.filter(t => !t.dead && t.activeRequests < maxConcurrentPerToken() && t.token);
  if (liveCandidates.length === 0) return null;

  let candidates = liveCandidates;
  if (preferVision) {
    const visionTokens = liveCandidates.filter(t => t.visionCapable === true);
    if (visionTokens.length > 0) candidates = visionTokens;
  } else {
    const nonVisionTokens = liveCandidates.filter(t => t.visionCapable !== true);
    if (nonVisionTokens.length > 0) candidates = nonVisionTokens;
  }
  // If the preferred subset is empty, fall back to liveCandidates (don't block
  // a vision request when only non-vision tokens are free, and vice versa).

  candidates.sort((a, b) => a.activeRequests - b.activeRequests);
  const chosen = candidates[0];
  chosen.activeRequests++;
  chosen.lastUsed = Date.now();

  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    chosen.activeRequests = Math.max(0, chosen.activeRequests - 1);
  };

  return { token: chosen.token, account: chosen, release };
}

export function reportTokenError(token) {
  const entry = tokenPool.find(t => t.token === token);
  if (!entry) return;
  entry.errorCount++;

  if (entry.errorCount >= tokenDeadThreshold()) {
    markTokenDead(entry);
  }
}

// Force a token into the dead state regardless of its current errorCount.
// Used when DeepSeek explicitly mutes/bans an account (biz_code=5, 40004).
export function markTokenDead(tokenOrEntry) {
  const entry = typeof tokenOrEntry === 'string'
    ? tokenPool.find(t => t.token === tokenOrEntry)
    : tokenOrEntry;
  if (!entry || entry.dead) return;
  entry.errorCount = tokenDeadThreshold();
  entry.dead = true;
  console.warn(`Token ${entry.token.slice(0, 12)}... marked DEAD (forced)`);

  if (entry.password) {
    refreshToken(entry).then(ok => {
      if (ok) {
        invalidateTokenSessions(entry.token);
      }
    }).catch(err => {
      console.warn(`refresh then-callback failed for ${entry.email}: ${err.message}`);
    });
  }
}

export function reportTokenSuccess(token) {
  const entry = tokenPool.find(t => t.token === token);
  if (!entry) return;
  entry.errorCount = 0;
  entry.lastUsed = Date.now();
  if (entry.dead) {
    entry.dead = false;
    console.log(`Token ${token.slice(0, 12)}... revived (was dead, now working)`);
  }
}

// Invalidate cached sessions for a token (after refresh)
function invalidateTokenSessions(token) {
  const prefix = token.slice(0, 12);
  invalidateSessionCache(prefix);
  // Also drop conversation-affinity bindings pointing at this token's sessions,
  // so chained turns don't keep targeting a now-stale session id.
  invalidateByTokenPrefix(prefix);
}

// Legacy: pickToken returns just the token string
let tokenIndex = 0;
export function pickToken(preferVision = false) {
  let candidates = tokenPool.filter(t => !t.dead && t.token);

  if (preferVision) {
    const visionTokens = candidates.filter(t => t.visionCapable === true);
    if (visionTokens.length > 0) candidates = visionTokens;
  } else {
    const nonVisionTokens = candidates.filter(t => t.visionCapable !== true);
    if (nonVisionTokens.length > 0) candidates = nonVisionTokens;
  }

  if (candidates.length === 0) {
    // Absolute fallback — use any token with a token string
    candidates = tokenPool.filter(t => t.token);
    if (candidates.length === 0) throw new Error('No tokens available in pool');
  }

  const idx = tokenIndex % candidates.length;
  const chosen = candidates[idx];
  tokenIndex++;
  return chosen.token;
}

// Legacy: sticky per-request token
let currentRequestToken = null;

export function setRequestToken(token) {
  currentRequestToken = token;
}

export function getRequestToken() {
  return currentRequestToken;
}

export async function getToken(preferVision = false) {
  if (currentRequestToken) return currentRequestToken;
  return pickToken(preferVision);
}

// Legacy: email/password login (adds to pool dynamically)
export async function loginAndAddToken(email, password) {
  const token = await login(email, password);
  // 优先更新同一邮箱名下 token 为 null 的旧条目，避免 push 后出现双条目
  // （一个旧 null-token + 一个新 token），导致 admin 测试回路报"无可用 Token"。
  const nullEntry = tokenPool.find(t => t.email === email && !t.token);
  if (nullEntry) {
    nullEntry.token = token;
    nullEntry.errorCount = 0;
    nullEntry.dead = false;
    const vision = await checkVisionCapability(token);
    nullEntry.visionCapable = vision;
    persistTokensToConfig();
    return token;
  }
  const existing = tokenPool.find(t => t.token === token);
  if (!existing) {
    const vision = await checkVisionCapability(token);
    tokenPool.push({ token, email, password, visionCapable: vision, lastUsed: 0, errorCount: 0, activeRequests: 0, dead: false });
    persistTokensToConfig();
  }
  return token;
}

export function buildPersistedTokenEnv(pool) {
  const seenTokens = new Set();
  const dsTokens = [];
  const dsAccountsExtended = [];
  const seenAccountLinks = new Set();

  for (const entry of pool) {
    const token = entry.token?.trim();
    if (!token || entry.dead || seenTokens.has(token)) continue;
    seenTokens.add(token);
    dsTokens.push(token);

    if (entry.email && entry.password) {
      const tokenPrefix = token.slice(0, 12);
      const linkKey = `${entry.email}:${tokenPrefix}`;
      if (!seenAccountLinks.has(linkKey)) {
        seenAccountLinks.add(linkKey);
        dsAccountsExtended.push(`${entry.email}:${entry.password}:${tokenPrefix}`);
      }
    }
  }

  return { dsTokens, dsAccountsExtended };
}

export function upsertEnvValues(content, updates) {
  const lines = content.split(/\r?\n/);
  const pending = new Map(Object.entries(updates));

  for (let i = 0; i < lines.length; i++) {
    const match = lines[i].match(/^([^#=\s][^=]*)=/);
    if (!match) continue;

    const key = match[1].trim();
    if (pending.has(key)) {
      lines[i] = `${key}=${pending.get(key)}`;
      pending.delete(key);
    }
  }

  for (const [key, value] of pending) {
    lines.push(`${key}=${value}`);
  }

  return lines.join('\n');
}

function persistTokensToConfig() {
  const { dsTokens } = buildPersistedTokenEnv(tokenPool);
  updateChannelConfig('deepseek', {
    ...getConfig().deepseek,
    tokens: dsTokens,
    accounts: tokenPool
      .filter(entry => entry.email && entry.password)
      .map(entry => ({ email: entry.email, password: entry.password })),
  });
}

export async function addTokenToPool(tokenStr) {
  const trimmed = tokenStr.trim();
  const existing = tokenPool.find(t => t.token === trimmed);
  if (existing) return existing;
  const entry = createTokenEntry({ token: trimmed });
  tokenPool.push(entry);
  persistTokensToConfig();
  return entry;
}

export function removeTokenFromPool(tokenPrefix) {
  const prefix = String(tokenPrefix || '').replace(/\.+$/, '').trim();
  if (!prefix || prefix === 'NONE') return false;

  const index = tokenPool.findIndex(entry => entry.token && entry.token.startsWith(prefix));
  if (index === -1) return false;

  const [removed] = tokenPool.splice(index, 1);
  invalidateTokenSessions(removed.token);
  persistTokensToConfig();
  return true;
}

// Periodic health check — validate alive tokens and detect banned accounts early
// Only checks tokens that haven't been used recently (idle tokens) to reduce request volume
function healthCheckIntervalMs() {
  return getConfig().deepseek.healthCheckIntervalSeconds * 1000;
}

function idleThresholdMs() {
  return getConfig().deepseek.idleThresholdSeconds * 1000;
}

async function healthCheck() {
  const now = Date.now();
  const idleThreshold = idleThresholdMs();
  // Only check idle tokens — recently used ones are assumed valid
  const idle = tokenPool.filter(t => !t.dead && t.token && (now - t.lastUsed) > idleThreshold);
  if (idle.length === 0) return;

  console.log(`Health check: ${idle.length} idle tokens (of ${tokenPool.filter(t => !t.dead).length} alive)`);

  for (const entry of idle) {
    const valid = await validateToken(entry.token);
    if (!valid) {
      console.log(`Health check: ${entry.token.slice(0, 12)}... INVALID — ${entry.password ? 'refreshing' : 'marking dead'}`);
      if (entry.password) {
        const ok = await refreshToken(entry);
        if (!ok && entry.dead) {
          console.log(`Health check: ${entry.email} is BANNED, removing from pool`);
          const idx = tokenPool.indexOf(entry);
          if (idx !== -1) tokenPool.splice(idx, 1);
        }
      } else {
        entry.dead = true;
        entry.errorCount = tokenDeadThreshold();
      }
    } else {
      entry.lastUsed = now; // reset idle timer on successful check
    }
  }
}

let healthCheckTimer = null;

export function startHealthCheck() {
  if (healthCheckTimer) return;
  const interval = healthCheckIntervalMs();
  healthCheckTimer = setInterval(healthCheck, interval);
  console.log(`Health check enabled: every ${interval / 1000}s`);
}

export function stopHealthCheck() {
  if (healthCheckTimer) {
    clearInterval(healthCheckTimer);
    healthCheckTimer = null;
  }
}

export function getPoolInfo() {
  return tokenPool.filter(t => !t.dead).map(t => ({
    token: t.token ? t.token.slice(0, 12) + '...' : 'NONE',
    email: t.email || null,
    visionCapable: t.visionCapable,
    errorCount: t.errorCount,
    activeRequests: t.activeRequests,
    dead: t.dead,
    maxConcurrent: maxConcurrentPerToken(),
  }));
}

export function getAliveTokens() {
  return tokenPool.filter(t => !t.dead && t.token).map(t => t.token);
}

export function getTotalCapacity() {
  return tokenPool.filter(t => !t.dead && t.token).length * maxConcurrentPerToken();
}

export async function testDeepSeekToken(token) {
  const valid = await validateToken(token);
  const visionCapable = valid ? await checkVisionCapability(token) : null;
  return { valid, visionCapable };
}

export function getDeepSeekTestToken() {
  const entry = tokenPool.find(t => !t.dead && t.token);
  return entry?.token || null;
}

export function getDeepSeekPoolEntries() {
  return tokenPool.filter(t => !t.dead).map(t => ({
    token: t.token,
    email: t.email || null,
    visionCapable: t.visionCapable,
    dead: t.dead,
  }));
}
