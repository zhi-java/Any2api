/**
 * API Client - DeepSeek 2API Admin
 *
 * 封装所有 API 调用
 */

// 获取 API Key
function getApiKey() {
  return localStorage.getItem('admin_api_key') || '';
}

// 通用请求方法
async function request(url, options = {}) {
  const apiKey = getApiKey();

  const headers = {
    'Content-Type': 'application/json',
    ...options.headers,
  };

  // 如果有 API Key，添加到请求头
  if (apiKey) {
    headers['Authorization'] = `Bearer ${apiKey}`;
  }

  const response = await fetch(url, {
    ...options,
    headers,
  });

  if (!response.ok) {
    if (response.status === 401) {
      // API Key 无效，清除并重新登录
      localStorage.removeItem('admin_api_key');
      window.location.reload();
      throw new Error('Unauthorized');
    }
    throw new Error(`HTTP ${response.status}: ${response.statusText}`);
  }

  return response.json();
}

const API = {
  base: '/admin/api',
  performanceBase: '/performance/api',

  /**
   * 获取统计信息
   */
  async getStats() {
    return request(`${this.base}/stats`);
  },

  /**
   * 获取日志
   */
  async getLogs(count = 50) {
    return request(`${this.base}/logs?count=${count}`);
  },

  /**
   * 获取历史日志
   */
  async getHistoricalLogs(date, count = 100) {
    return request(`${this.base}/logs/history?date=${date}&count=${count}`);
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
