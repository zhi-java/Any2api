// 后端公开配置与状态的类型契约。字段与 src/services/config-store.js 的
// getPublicConfig() / routes/admin.js 的响应保持一致。

export type ChannelId = 'deepseek';

export type ChannelStatus = 'healthy' | 'degraded' | 'unconfigured' | 'unavailable';

export interface CredentialSummary {
  id: string;
  label: string;
  configured: boolean;
  /** 账号型凭据才有 */
  email?: string;
  hasPassword?: boolean;
}

/** 外部 API Key 的公开摘要（比渠道凭据多 name / createdAt）。 */
export interface ApiKeySummary extends CredentialSummary {
  name: string;
  createdAt: string;
}

export interface ChannelUsage {
  requests: number;
  errors: number;
  rpm: number;
  tokenSpeed: number;
}

export interface Channel {
  id: ChannelId;
  name: string;
  configured: boolean;
  credentialCount: number;
  availableCount: number;
  activeRequests: number;
  capacity: number;
  mode: string;
  status: ChannelStatus;
  recentErrors: number;
  lastError: LogEntry | null;
  usage: ChannelUsage;
  queue?: { queued: number; maxQueueSize: number };
  detail?: unknown;
}

export interface ModelInfo {
  id: string;
  channel: ChannelId;
  owned_by: string;
  capabilities: Record<string, boolean>;
}

export interface LogEntry {
  time: string;
  status: number;
  method?: string;
  path?: string;
  duration?: number;
  channel?: string;
  model?: string;
  level?: string;
  message?: string;
}

export interface ServerConfig {
  apiKeyConfigured: boolean;
  apiKey: string;
  apiKeys: ApiKeySummary[];
  externalApiKeyCount: number;
  adminKeyAcceptedForApi: boolean;
  mergeThinking: boolean;
  enablePromptInjection: boolean;
  clientDebugLog: boolean;
  clientDebugLogDir: string;
  clientDebugLogMaxChars: number;
  systemFingerprint: string;
}

export interface RuntimeConfig {
  sessionTtlSeconds: number;
  enableConversationAffinity: boolean;
  conversationTtlMs: number;
  maxConversations: number;
  enableFcErrorRetry: boolean;
  logDir: string;
}

export interface DeepSeekConfig {
  authMode: string;
  tokenCount: number;
  tokens: CredentialSummary[];
  accounts: CredentialSummary[];
  maxConcurrentPerToken: number;
  tokenDeadThreshold: number;
  healthCheckIntervalSeconds: number;
  idleThresholdSeconds: number;
  validateOnStartup: boolean;
  prewarmSessions: boolean;
  /** 展示用的缓存命中率（0–100），非上游真实缓存统计 */
  reportedCacheHitRate: number;
}

export interface PublicConfig {
  version: number;
  paths: {
    config: string;
    dataDir: string;
    logDir: string;
    clientDebugLogDir: string;
  };
  loadError: string | null;
  server: ServerConfig;
  runtime: RuntimeConfig;
  deepseek: DeepSeekConfig;
}

export interface Stats {
  status: string;
  version: string;
  uptimeSeconds: number;
  serverUrl: string;
  proxyUrl: string | null;
  queue: { queued: number; maxQueueSize: number };
  channels: Channel[];
  logStats: { totalRequests: number; successCount: number; errorCount: number; last5min: number };
  metrics: Metrics;
}

export interface Metrics {
  rpm?: number;
  ttfbP50?: number;
  ttfbP90?: number;
  tokenSpeed?: number;
  errorRate?: number;
}

export interface TimeseriesPoint {
  ts?: number;
  t?: string;
  time?: number;
  rpm?: number;
  ttfbP50?: number;
  ttfbP90?: number;
  tokenSpeed?: number;
  errorRate?: number;
}

export interface ChannelTestResult {
  success: boolean;
  channel: string;
  removed?: boolean;
  results: { label: string; success: boolean; message: string }[];
}
