/**
 * GLM Token 管理器
 *
 * 管理 GLM 三层 Token 体系：访客 Token → Refresh Token → Access Token
 * 支持多个 refresh token 的轮询和缓存
 */

import { makeTimestamp, makeNonce, makeSign, makeAuthHeaders } from './utils.js';

const GUEST_ACCESS_URL = 'https://chatglm.cn/chatglm/user-api/guest/access';
const USER_REFRESH_URL = 'https://chatglm.cn/chatglm/user-api/user/refresh';

export class GlmTokenManager {
  constructor() {
    // Token 池加载（支持多个 tokens）
    this.tokens = this._loadTokens();
    this.currentIndex = 0;

    // 每个 refresh token 的 access token 独立缓存
    // Map<refreshToken, {accessToken, expiresAt, userId}>
    this.tokenCache = new Map();

    this._pending = null; // 并发去重
  }

  /** 从环境变量加载 token 池 */
  _loadTokens() {
    // 优先级 1: GLM_REFRESH_TOKENS (多个 tokens, 逗号分隔)
    if (process.env.GLM_REFRESH_TOKENS) {
      const tokens = process.env.GLM_REFRESH_TOKENS
        .split(',')
        .map(t => t.trim())
        .filter(Boolean);

      if (tokens.length > 0) {
        console.log(`[GLM] Loaded ${tokens.length} tokens from GLM_REFRESH_TOKENS`);
        return tokens;
      }
    }

    // 优先级 2: GLM_REFRESH_TOKEN (单个 token, 向后兼容)
    if (process.env.GLM_REFRESH_TOKEN) {
      console.log('[GLM] Loaded 1 token from GLM_REFRESH_TOKEN');
      return [process.env.GLM_REFRESH_TOKEN];
    }

    // 优先级 3: 空数组（访客模式）
    console.log('[GLM] No tokens configured, will use guest mode');
    return [];
  }

  /** 轮询选择下一个 refresh token */
  _selectToken() {
    if (this.tokens.length === 0) {
      return null;
    }

    const token = this.tokens[this.currentIndex];
    this.currentIndex = (this.currentIndex + 1) % this.tokens.length;
    return token;
  }

  /** 获取有效的 access token（自动缓存和刷新） */
  async getAccessToken() {
    if (this._pending) return this._pending;

    this._pending = this._acquireToken();
    try {
      return await this._pending;
    } finally {
      this._pending = null;
    }
  }

  async _acquireToken() {
    // 如果有 token 池，轮询选择
    if (this.tokens.length > 0) {
      const refreshToken = this._selectToken();
      return await this._getAccessTokenForRefresh(refreshToken);
    }

    // 降级到访客模式
    return await this._guestAccessToken();
  }

  /** 为指定的 refresh token 获取 access token（带缓存） */
  async _getAccessTokenForRefresh(refreshToken) {
    // 检查缓存
    const cached = this.tokenCache.get(refreshToken);
    if (cached && Date.now() < cached.expiresAt - 60_000) {
      return cached.accessToken;
    }

    // 刷新 token
    try {
      const result = await this._refresh(refreshToken);

      // 更新缓存
      this.tokenCache.set(refreshToken, {
        accessToken: result.access_token,
        expiresAt: Date.now() + 3600 * 1000,
        userId: result.user_id || null,
      });

      // 如果返回了新的 refresh token，更新池中的 token
      if (result.refresh_token && result.refresh_token !== refreshToken) {
        const index = this.tokens.indexOf(refreshToken);
        if (index !== -1) {
          this.tokens[index] = result.refresh_token;
          // 将缓存迁移到新 token
          this.tokenCache.set(result.refresh_token, this.tokenCache.get(refreshToken));
          this.tokenCache.delete(refreshToken);
        }
      }

      return result.access_token;
    } catch (err) {
      console.warn(`[GLM] Refresh token failed: ${err.message}, falling back to guest mode`);

      // 刷新失败，降级到访客模式
      return await this._guestAccessToken();
    }
  }

  /** 访客模式获取 token（带缓存） */
  async _guestAccessToken() {
    // 检查访客模式缓存（key 为 'guest'）
    const cached = this.tokenCache.get('guest');
    if (cached && Date.now() < cached.expiresAt - 60_000) {
      return cached.accessToken;
    }

    // 获取新的访客 token
    const guest = await this._guestAccess();

    // 缓存访客 token
    this.tokenCache.set('guest', {
      accessToken: guest.access_token,
      expiresAt: Date.now() + 3600 * 1000,
      userId: guest.user_id,
    });

    return guest.access_token;
  }

  /** 获取访客 refresh_token + access_token */
  async _guestAccess() {
    const ts = makeTimestamp();
    const nonce = makeNonce();
    const sign = makeSign(ts, nonce);
    const headers = makeAuthHeaders(ts, nonce, sign);

    const res = await fetch(GUEST_ACCESS_URL, {
      method: 'POST',
      headers,
      body: '{}',
    });
    const json = await res.json();
    if (json.status !== 0) {
      throw new Error(`GLM guest access failed: ${JSON.stringify(json)}`);
    }
    return json.result;
  }

  /** 用 refresh token 换取新的 access token */
  async _refresh(refreshToken) {
    const ts = makeTimestamp();
    const nonce = makeNonce();
    const sign = makeSign(ts, nonce);
    const headers = {
      ...makeAuthHeaders(ts, nonce, sign),
      Authorization: `Bearer ${refreshToken}`,
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      Referer: 'https://chatglm.cn/',
    };

    const res = await fetch(USER_REFRESH_URL, {
      method: 'POST',
      headers,
      body: '{}',
    });
    const json = await res.json();
    if (json.code !== 0) {
      throw new Error(`GLM token refresh failed: ${JSON.stringify(json)}`);
    }
    return json.result;
  }

  /** 重置认证状态（外部调用，如发现 401 时） */
  reset() {
    this.tokenCache.clear();
    this._pending = null;
  }
}
