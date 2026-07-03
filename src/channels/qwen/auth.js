import { createHash } from 'crypto';
import { requestHeaders } from './headers.js';
import { qwenSettings } from './config.js';

const BASE_URL = 'https://chat.qwen.ai';

function now() {
  return Date.now();
}

function sha256(text) {
  return createHash('sha256').update(text, 'utf-8').digest('hex');
}

function decodeJWT(token) {
  try {
    const payload = token.split('.')[1];
    return JSON.parse(Buffer.from(payload, 'base64url').toString('utf-8'));
  } catch {
    return null;
  }
}

function isTokenExpired(token) {
  const decoded = decodeJWT(token);
  if (!decoded?.exp) return true;
  return decoded.exp * 1000 < now() + 5 * 60 * 1000;
}

function createEntry({ email, password = null, token = null }) {
  const decoded = token ? decodeJWT(token) : null;
  return {
    email: email || decoded?.id || 'token-user',
    password,
    token,
    expiresAt: token ? (decoded?.exp || 0) * 1000 : 0,
    errorCount: 0,
    activeRequests: 0,
    rateLimitedUntil: 0,
    lastRequestStarted: 0,
    lastError: '',
    rateLimitStrikes: 0,
  };
}

export class QwenTokenManager {
  constructor() {
    this.accounts = this._loadAccounts();
    this._pendingLogin = new Map();
  }

  _loadAccounts() {
    const accounts = [];
    const accountsStr = process.env.QWEN_ACCOUNTS?.trim();
    const tokensStr = process.env.QWEN_TOKENS?.trim();

    if (accountsStr) {
      for (const entry of accountsStr.split(',')) {
        const [email, ...passParts] = entry.trim().split(':');
        const password = passParts.join(':');
        if (email && password) accounts.push(createEntry({ email, password }));
      }
    }

    if (tokensStr) {
      for (const token of tokensStr.split(',').map(t => t.trim()).filter(Boolean)) {
        accounts.push(createEntry({ token }));
      }
    }

    if (accounts.length === 0) {
      console.warn('[Qwen] No QWEN_TOKENS or QWEN_ACCOUNTS configured; qwen channel will return 503 until configured.');
    } else {
      console.log(`[Qwen] Loaded ${accounts.length} account(s)`);
    }
    return accounts;
  }

  _cooldownRemaining(entry) {
    return Math.max(0, (entry.rateLimitedUntil || 0) - now());
  }

  _nextAvailableAt(entry) {
    return Math.max(entry.rateLimitedUntil || 0, (entry.lastRequestStarted || 0) + qwenSettings.accountMinIntervalMs);
  }

  _canAttempt(entry, timestamp = now()) {
    if (entry.activeRequests >= qwenSettings.maxConcurrentPerToken) return false;
    if (entry.errorCount >= qwenSettings.maxTokenErrors) return false;
    if (this._nextAvailableAt(entry) > timestamp) return false;
    if (entry.token && !isTokenExpired(entry.token)) return true;
    return !!entry.password;
  }

  async _login(email, password) {
    const res = await fetch(`${BASE_URL}/api/v1/auths/signin`, {
      method: 'POST',
      headers: requestHeaders(),
      body: JSON.stringify({ email, password: sha256(password) }),
    });

    const text = await res.text();
    let json = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      const contentType = res.headers.get('content-type') || 'unknown content-type';
      const looksHtml = /^\s*</.test(text);
      const detail = looksHtml
        ? 'received HTML instead of JSON, likely a Qwen/WAF login challenge'
        : `received non-JSON response: ${text.slice(0, 120).replace(/\s+/g, ' ')}`;
      throw new Error(`Qwen login failed: HTTP ${res.status} ${contentType}; ${detail}`);
    }

    if (!res.ok) {
      const message = json?.detail || json?.message || json?.error || res.statusText || 'login failed';
      throw new Error(`Qwen login failed: HTTP ${res.status}: ${message}`);
    }

    if (!json?.token) {
      const message = json?.detail || json?.message || json?.error || 'missing token in login response';
      throw new Error(`Qwen login failed: ${message}`);
    }
    return json.token;
  }

  async _ensureToken(entry) {
    if (entry.token && !isTokenExpired(entry.token)) return entry.token;
    if (!entry.password) {
      entry.errorCount++;
      entry.lastError = 'expired_no_password';
      throw new Error(`Qwen token expired for ${entry.email}, no password to refresh`);
    }

    const key = entry.email;
    if (this._pendingLogin.has(key)) return this._pendingLogin.get(key);

    const pending = this._login(entry.email, entry.password)
      .then(token => {
        const decoded = decodeJWT(token);
        entry.token = token;
        entry.expiresAt = (decoded?.exp || 0) * 1000;
        entry.errorCount = 0;
        entry.lastError = '';
        entry.rateLimitedUntil = 0;
        entry.rateLimitStrikes = 0;
        return token;
      })
      .catch(err => {
        entry.errorCount++;
        entry.lastError = err.message;
        throw err;
      })
      .finally(() => this._pendingLogin.delete(key));

    this._pendingLogin.set(key, pending);
    return pending;
  }

  async acquireToken() {
    const timestamp = now();
    const candidates = this.accounts
      .filter(entry => this._canAttempt(entry, timestamp))
      .sort((a, b) => a.activeRequests - b.activeRequests || (a.lastRequestStarted || 0) - (b.lastRequestStarted || 0));

    for (const entry of candidates) {
      try {
        const token = await this._ensureToken(entry);
        entry.activeRequests++;
        entry.lastRequestStarted = timestamp;
        let released = false;
        return {
          token,
          account: entry,
          release() {
            if (released) return;
            released = true;
            entry.activeRequests = Math.max(0, entry.activeRequests - 1);
          },
        };
      } catch (err) {
        console.warn(`[Qwen] Failed to acquire token for ${entry.email}: ${err.message}`);
      }
    }

    return null;
  }

  reportTokenFailure(token, { statusCode, message = '' } = {}) {
    const entry = this.accounts.find(item => item.token === token);
    if (!entry) return;

    entry.errorCount++;
    entry.lastError = message || (statusCode ? `HTTP ${statusCode}` : 'upstream_error');

    if (statusCode === 429) {
      entry.rateLimitStrikes = (entry.rateLimitStrikes || 0) + 1;
      const cooldown = Math.min(
        qwenSettings.rateLimitMaxCooldownMs,
        qwenSettings.rateLimitBaseCooldownMs * (2 ** Math.max(0, entry.rateLimitStrikes - 1)),
      );
      entry.rateLimitedUntil = now() + cooldown;
      entry.lastError = `rate_limited_${Math.ceil(cooldown / 1000)}s`;
    } else if (statusCode === 401 || statusCode === 403) {
      entry.lastError = statusCode === 401 ? 'auth_error' : 'forbidden';
      entry.rateLimitedUntil = now() + qwenSettings.rateLimitBaseCooldownMs;
    }
  }

  reportTokenSuccess(token) {
    const entry = this.accounts.find(item => item.token === token);
    if (!entry) return;
    entry.errorCount = 0;
    entry.lastError = '';
    entry.rateLimitStrikes = 0;
  }

  getNextAvailableDelayMs() {
    const timestamp = now();
    const candidates = this.accounts.filter(entry =>
      entry.errorCount < qwenSettings.maxTokenErrors &&
      entry.activeRequests < qwenSettings.maxConcurrentPerToken &&
      (entry.password || (entry.token && !isTokenExpired(entry.token)))
    );
    if (candidates.length === 0) return null;
    const nextTime = Math.min(...candidates.map(entry => this._nextAvailableAt(entry)));
    return Math.max(0, nextTime - timestamp);
  }

  getUnavailableReason() {
    if (this.accounts.length === 0) {
      return 'No Qwen credentials configured. Set QWEN_TOKENS or QWEN_ACCOUNTS and restart the service.';
    }

    const statuses = this.getPoolInfo();
    if (statuses.every(entry => entry.lastError === 'expired_no_password')) {
      return 'All configured Qwen tokens are expired and no QWEN_ACCOUNTS password is available to refresh them.';
    }
    if (statuses.every(entry => entry.errorCount >= qwenSettings.maxTokenErrors)) {
      return 'All configured Qwen accounts exceeded the error limit. Check token validity or upstream errors.';
    }

    return 'No Qwen token is currently available.';
  }

  getPoolInfo() {
    return this.accounts.map(entry => ({
      email: entry.email,
      hasToken: !!entry.token,
      expiresAt: entry.expiresAt ? new Date(entry.expiresAt).toISOString() : null,
      errorCount: entry.errorCount,
      activeRequests: entry.activeRequests,
      maxConcurrent: qwenSettings.maxConcurrentPerToken,
      cooldownRemainingMs: this._cooldownRemaining(entry),
      nextAvailableInMs: Math.max(0, this._nextAvailableAt(entry) - now()),
      lastError: entry.lastError || '',
    }));
  }
}
