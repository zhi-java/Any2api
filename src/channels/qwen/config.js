function readInt(name, fallback, min = 0) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const value = Number.parseInt(raw, 10);
  if (!Number.isFinite(value)) return fallback;
  return Math.max(min, value);
}

export const qwenSettings = {
  maxConcurrentPerToken: readInt('QWEN_MAX_CONCURRENT_PER_TOKEN', readInt('MAX_CONCURRENT_PER_TOKEN', 1, 1), 1),
  maxQueueSize: readInt('QWEN_MAX_QUEUE_SIZE', readInt('MAX_QUEUE_SIZE', 100, 0), 0),
  queueTimeoutMs: readInt('QWEN_QUEUE_TIMEOUT_MS', readInt('QUEUE_TIMEOUT_MS', 30000, 1000), 1000),
  accountMinIntervalMs: readInt('QWEN_ACCOUNT_MIN_INTERVAL_MS', readInt('ACCOUNT_MIN_INTERVAL_MS', 1200, 0), 0),
  rateLimitBaseCooldownMs: readInt('QWEN_RATE_LIMIT_BASE_COOLDOWN_MS', readInt('RATE_LIMIT_BASE_COOLDOWN_MS', 10 * 60 * 1000, 1000), 1000),
  rateLimitMaxCooldownMs: readInt('QWEN_RATE_LIMIT_MAX_COOLDOWN_MS', readInt('RATE_LIMIT_MAX_COOLDOWN_MS', 60 * 60 * 1000, 1000), 1000),
  maxTokenErrors: readInt('QWEN_MAX_TOKEN_ERRORS', readInt('MAX_TOKEN_ERRORS', 3, 1), 1),
};

export function updateQwenSettings(settings = {}) {
  for (const key of Object.keys(qwenSettings)) {
    if (settings[key] !== undefined) qwenSettings[key] = settings[key];
  }
}
