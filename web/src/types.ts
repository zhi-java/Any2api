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
  /** 是否被禁用（风控/失效等）。禁用凭据不参与调度，但保留在配置中可恢复。 */
  disabled?: boolean;
  disabledReason?: string;
  /** 自动恢复时刻（绝对时间戳，ms）；0 表示手动禁用、不自动恢复 */
  disabledUntil?: number;
  disabledAt?: number;
  disabledSource?: 'auto' | 'manual' | null;
  /** 距自动恢复剩余毫秒，0 表示无自动恢复计划 */
  disabledRemainingMs?: number;
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
  /** 凭据总数（含禁用项） */
  credentialCount: number;
  /** 可用凭据数（不含禁用项） */
  availableCount: number;
  /** 被禁用的凭据数 */
  disabledCount?: number;
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
  /** 禁用凭据数（含 token 与账号） */
  disabledCount?: number;
  maxConcurrentPerToken: number;
  tokenDeadThreshold: number;
  healthCheckIntervalSeconds: number;
  idleThresholdSeconds: number;
  validateOnStartup: boolean;
  prewarmSessions: boolean;
  /** 展示用的缓存命中率（0–100），非上游真实缓存统计 */
  reportedCacheHitRate: number;
  /** 对外上报的上下文窗口（tokens） */
  contextLength: number;
  /** 对外上报的单次最大输出（tokens） */
  maxOutputTokens: number;
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

export interface SessionInfo {
  count: number;
  ttl: number;
  sessions: { key: string; modelType: string; ageSeconds: number; ttlRemainingSeconds: number; requestCount: number }[];
}

export interface ConversationInfo {
  enabled?: boolean;
  active?: number;
  maxConversations?: number;
  ttlMs?: number;
  affinityEnabled: boolean;
}

export interface Stats {
  status: string;
  version: string;
  uptimeSeconds: number;
  serverUrl: string;
  /** 出站代理。为 null 表示未配置 —— 所有账号共用同一出口 IP，风控风险显著升高。 */
  proxyUrl: string | null;
  queue: { queued: number; maxQueueSize: number };
  channels: Channel[];
  /** 上游 token 池的总并发容量 */
  totalCapacity: number;
  sessions: SessionInfo;
  conversations: ConversationInfo;
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
  /** 无效凭据是否已被禁用（替代旧的 removed：旧逻辑会删除凭据） */
  disabled?: boolean;
  disabledCount?: number;
  results: { label: string; success: boolean; message: string }[];
}
