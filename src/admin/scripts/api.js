/**
 * API Client - OmniAPI Admin
 *
 * 封装所有 API 调用
 */

// 获取旧版本地 API Key（兼容手动 Bearer 调用）
function getApiKey() {
  return localStorage.getItem('admin_api_key') || '';
}

async function errorFromResponse(response) {
  try {
    const body = await response.json();
    return body?.error?.message || body?.message || `HTTP ${response.status}: ${response.statusText}`;
  } catch {
    return `HTTP ${response.status}: ${response.statusText}`;
  }
}

function notifyAuthExpired() {
  window.dispatchEvent(new CustomEvent('auth:expired'));
}

// 通用请求方法
async function request(url, options = {}) {
  const apiKey = getApiKey();

  const headers = {
    'Content-Type': 'application/json',
    ...options.headers,
  };

  // 如果有旧版 API Key，继续添加到请求头；桌面端优先使用 HttpOnly Cookie 会话。
  if (apiKey) {
    headers['Authorization'] = `Bearer ${apiKey}`;
  }

  const response = await fetch(url, {
    credentials: 'same-origin',
    ...options,
    headers,
  });

  if (!response.ok) {
    if (response.status === 401) {
      localStorage.removeItem('admin_api_key');
      notifyAuthExpired();
      throw new Error('Unauthorized');
    }
    throw new Error(await errorFromResponse(response));
  }

  return response.json();
}

const API = {
  base: '/admin/api',
  performanceBase: '/performance/api',

  async getAuthStatus() {
    return request(`${this.base}/auth/status`);
  },

  async login(apiKey) {
    return request(`${this.base}/auth/login`, {
      method: 'POST',
      body: JSON.stringify({ apiKey }),
    });
  },

  async logout() {
    return request(`${this.base}/auth/logout`, { method: 'POST' });
  },

  async getConfig() {
    return request(`${this.base}/config`);
  },

  async updateConfig(patch) {
    return request(`${this.base}/config`, {
      method: 'PATCH',
      body: JSON.stringify(patch),
    });
  },

  async createServerApiKey(payload) {
    return request(`${this.base}/server/api-keys`, {
      method: 'POST',
      body: JSON.stringify(payload),
    });
  },

  async removeServerApiKey(id) {
    return request(`${this.base}/server/api-keys/${encodeURIComponent(id)}`, {
      method: 'DELETE',
    });
  },

  async getChannelConfig(channel) {
    return request(`${this.base}/channels/${channel}/config`);
  },

  async updateChannelConfig(channel, config) {
    return request(`${this.base}/channels/${channel}/config`, {
      method: 'PUT',
      body: JSON.stringify(config),
    });
  },

  async addCredential(channel, payload) {
    return request(`${this.base}/channels/${channel}/credentials`, {
      method: 'POST',
      body: JSON.stringify(payload),
    });
  },

  async removeCredential(channel, id) {
    return request(`${this.base}/channels/${channel}/credentials/${encodeURIComponent(id)}`, {
      method: 'DELETE',
    });
  },

  async testChannel(channel, payload = {}) {
    return request(`${this.base}/channels/${channel}/test`, {
      method: 'POST',
      body: JSON.stringify(payload),
    });
  },

  /**
   * 获取统计信息
   */
  async getStats() {
    return request(`${this.base}/stats`);
  },

  /**
   * 获取统一健康状态
   */
  async getHealth() {
    return request(`${this.base}/health`);
  },

  /**
   * 获取渠道状态
   */
  async getChannels() {
    return request(`${this.base}/channels`);
  },

  /**
   * 获取模型清单
   */
  async getModels() {
    return request(`${this.base}/models`);
  },

  /**
   * 获取日志
   */
  async getLogs(count = 50, filters = {}) {
    const params = new URLSearchParams({ count: String(count), ...filters });
    return request(`${this.base}/logs?${params}`);
  },

  /**
   * 获取历史日志
   */
  async getHistoricalLogs(date, count = 100, filters = {}) {
    const params = new URLSearchParams({ date, count: String(count), ...filters });
    return request(`${this.base}/logs/history?${params}`);
  },

  /**
   * 获取日志日期列表
   */
  async getLogDates() {
    return request(`${this.base}/logs/dates`);
  },

  /**
   * 获取聊天日志
   */
  async getChatLogs(date, count = 100) {
    return request(`${this.base}/logs/chats?date=${date}&count=${count}`);
  },

  /**
   * 添加 Token
   */
  async addToken(token) {
    return request(`${this.base}/token/add`, {
      method: 'POST',
      body: JSON.stringify({ token }),
    });
  },

  /**
   * 账号登录添加 Token
   */
  async loginAndAddToken(email, password) {
    return request(`${this.base}/token/login`, {
      method: 'POST',
      body: JSON.stringify({ email, password }),
    });
  },

  /**
   * 删除 Token
   */
  async removeToken(tokenPrefix) {
    return request(`${this.base}/token/remove`, {
      method: 'POST',
      body: JSON.stringify({ tokenPrefix }),
    });
  },

  /**
   * 获取性能指标
   */
  async getMetrics(query = {}) {
    const params = new URLSearchParams(query);
    return request(`${this.performanceBase}/metrics?${params}`);
  },

  /**
   * 获取时间序列数据
   */
  async getTimeseries(query = {}) {
    const params = new URLSearchParams(query);
    return request(`${this.performanceBase}/timeseries?${params}`);
  },
};

export default API;
