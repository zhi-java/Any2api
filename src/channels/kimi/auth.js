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
  if (!decoded?.exp) return false;
  return decoded.exp * 1000 < Date.now() + 5 * 60 * 1000;
}

function createEntry(token) {
  const decoded = decodeJWT(token);
  return {
    token,
    user: decoded?.sub || decoded?.abstract_user_id || 'token-user',
    expiresAt: decoded?.exp ? decoded.exp * 1000 : 0,
    activeRequests: 0,
    errorCount: 0,
    lastError: '',
    lastFailedAt: 0,
  };
}

export class KimiTokenManager {
  constructor() {
    this.tokens = this._loadTokens();
    if (this.tokens.length === 0) {
      console.warn('[Kimi] No KIMI_AUTH_TOKEN or KIMI_AUTH_TOKENS configured; kimi channel will return 503 until configured.');
    } else {
      console.log(`[Kimi] Loaded ${this.tokens.length} token(s)`);
    }
  }

  _loadTokens() {
    const raw = process.env.KIMI_AUTH_TOKENS || process.env.KIMI_AUTH_TOKEN || '';
    return raw.split(',').map(t => t.trim()).filter(Boolean).map(createEntry);
  }

  acquireToken() {
    const entry = this.tokens
      .filter(item => !isTokenExpired(item.token) && item.errorCount < 3)
      .sort((a, b) =>
        a.activeRequests - b.activeRequests
        || a.errorCount - b.errorCount
        || a.lastFailedAt - b.lastFailedAt
      )[0];
    if (!entry) return null;
    entry.activeRequests++;
    let released = false;
    return {
      token: entry.token,
      release() {
        if (released) return;
        released = true;
        entry.activeRequests = Math.max(0, entry.activeRequests - 1);
      },
    };
  }

  reportTokenFailure(token, message = '') {
    const entry = this.tokens.find(item => item.token === token);
    if (!entry) return;
    entry.errorCount++;
    entry.lastError = message || 'upstream_error';
    entry.lastFailedAt = Date.now();
  }

  reportTokenSuccess(token) {
    const entry = this.tokens.find(item => item.token === token);
    if (!entry) return;
    entry.errorCount = 0;
    entry.lastError = '';
    entry.lastFailedAt = 0;
  }

  getUnavailableReason() {
    if (this.tokens.length === 0) {
      return 'No Kimi credentials configured. Set KIMI_AUTH_TOKEN or KIMI_AUTH_TOKENS and restart the service.';
    }
    if (this.tokens.every(item => isTokenExpired(item.token))) {
      return 'All configured Kimi tokens are expired.';
    }
    return 'No Kimi token is currently available.';
  }

  getPoolInfo() {
    return this.tokens.map(entry => ({
      user: entry.user,
      expiresAt: entry.expiresAt ? new Date(entry.expiresAt).toISOString() : null,
      activeRequests: entry.activeRequests,
      errorCount: entry.errorCount,
      lastError: entry.lastError,
    }));
  }
}
