// 管理后台 API 客户端。鉴权走 HttpOnly Cookie 会话（登录后由服务端下发），
// 调用方无需自行管理 token。

import type { Channel, ChannelTestResult, LogEntry, ModelInfo, PublicConfig, Stats, TimeseriesPoint } from '../types';

const BASE = '/admin/api';
const PERF_BASE = '/performance/api';

export class ApiError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
  }
}

function notifyAuthExpired() {
  window.dispatchEvent(new CustomEvent('auth:expired'));
}

async function errorMessage(response: Response): Promise<string> {
  try {
    const body = await response.json();
    return body?.error?.message || body?.message || `HTTP ${response.status}: ${response.statusText}`;
  } catch {
    return `HTTP ${response.status}: ${response.statusText}`;
  }
}

async function request<T>(url: string, options: RequestInit = {}): Promise<T> {
  const response = await fetch(url, {
    credentials: 'same-origin',
    ...options,
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
  });

  if (!response.ok) {
    // 登录接口自身的 401 表示"凭据错误"，不是"会话过期"。若不排除，
    // 用户在过期弹窗里输错 Key 会再次触发 auth:expired 广播，语义混乱。
    const isAuthEndpoint = url.includes('/auth/login') || url.includes('/auth/status');
    if (response.status === 401 && !isAuthEndpoint) notifyAuthExpired();
    throw new ApiError(await errorMessage(response), response.status);
  }
  return response.json() as Promise<T>;
}

export const api = {
  // ---- 鉴权 ----
  authStatus: () =>
    request<{ authRequired: boolean; authenticated: boolean }>(`${BASE}/auth/status`),
  login: (apiKey: string) =>
    request<{ success: boolean }>(`${BASE}/auth/login`, {
      method: 'POST',
      body: JSON.stringify({ apiKey }),
    }),
  logout: () => request<{ success: boolean }>(`${BASE}/auth/logout`, { method: 'POST' }),

  // ---- 配置 ----
  getConfig: () => request<{ config: PublicConfig }>(`${BASE}/config`),
  updateConfig: (patch: Record<string, unknown>) =>
    request<{ success: boolean; config: PublicConfig }>(`${BASE}/config`, {
      method: 'PATCH',
      body: JSON.stringify(patch),
    }),

  // ---- 外部 API Key ----
  createServerApiKey: (payload: { name?: string; key?: string }) =>
    request<{ success: boolean; key: string; config: PublicConfig['server'] }>(
      `${BASE}/server/api-keys`,
      { method: 'POST', body: JSON.stringify(payload) },
    ),
  removeServerApiKey: (id: string) =>
    request<{ success: boolean; config: PublicConfig['server'] }>(
      `${BASE}/server/api-keys/${encodeURIComponent(id)}`,
      { method: 'DELETE' },
    ),

  // ---- 渠道凭据 ----
  getChannelConfig: (channel: string) =>
    request<{ channel: string; config: Record<string, unknown> }>(`${BASE}/channels/${channel}/config`),
  updateChannelConfig: (channel: string, config: Record<string, unknown>) =>
    request<{ success: boolean }>(`${BASE}/channels/${channel}/config`, {
      method: 'PUT',
      body: JSON.stringify(config),
    }),
  addCredential: (channel: string, payload: Record<string, unknown>) =>
    request<{ success: boolean }>(`${BASE}/channels/${channel}/credentials`, {
      method: 'POST',
      body: JSON.stringify(payload),
    }),
  removeCredential: (channel: string, id: string) =>
    request<{ success: boolean }>(`${BASE}/channels/${channel}/credentials/${encodeURIComponent(id)}`, {
      method: 'DELETE',
    }),
  /** 启用/禁用凭据。禁用只改状态、不删配置，可随时启用恢复。 */
  setCredentialDisabled: (channel: string, id: string, disabled: boolean) =>
    request<{ success: boolean }>(
      `${BASE}/channels/${channel}/credentials/${encodeURIComponent(id)}`,
      { method: 'PATCH', body: JSON.stringify({ disabled }) },
    ),
  testChannel: (channel: string) =>
    request<ChannelTestResult>(`${BASE}/channels/${channel}/test`, { method: 'POST', body: '{}' }),

  // ---- 状态 ----
  getStats: () => request<Stats>(`${BASE}/stats`),
  getChannels: () => request<{ channels: Channel[] }>(`${BASE}/channels`),
  getModels: () => request<{ models: ModelInfo[] }>(`${BASE}/models`),

  // ---- 日志 ----
  getLogs: (count: string, filters: Record<string, string>) => {
    const params = new URLSearchParams({ count, ...filters });
    return request<{ logs: LogEntry[]; stats: Stats['logStats'] }>(`${BASE}/logs?${params}`);
  },

  // ---- 监控 ----
  getMetrics: () => request<MetricsResponse>(`${PERF_BASE}/metrics`),
  getTimeseries: (range: string) =>
    request<{ points: TimeseriesPoint[] }>(`${PERF_BASE}/timeseries?range=${range}`),
};

export interface MetricsResponse {
  rpm?: number;
  ttfbP50?: number;
  ttfbP90?: number;
  tokenSpeed?: number;
  errorRate?: number;
}
