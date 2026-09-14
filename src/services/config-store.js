import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { dirname, resolve } from 'path';
import { createHash, randomBytes, timingSafeEqual } from 'crypto';
import { appRootPath } from '../utils/runtime-paths.js';

const DEFAULT_CONFIG = Object.freeze({
  version: 1,
  server: {
    apiKey: '',
    apiKeys: [],
    mergeThinking: false,
    enablePromptInjection: true,
    clientDebugLog: false,
    clientDebugLogDir: '',
    clientDebugLogMaxChars: 200000,
    systemFingerprint: 'fp_omni_v1',
  },
  runtime: {
    sessionTtlSeconds: 1800,
    enableConversationAffinity: false,
    conversationTtlMs: 1800000,
    maxConversations: 500,
    enableFcErrorRetry: true,
    logDir: '',
  },
  deepseek: {
    tokens: [],
    accounts: [],
    maxConcurrentPerToken: 2,
    tokenDeadThreshold: 5,
    healthCheckIntervalSeconds: 600,
    idleThresholdSeconds: 1800,
    validateOnStartup: false,
    prewarmSessions: false,
    // 上报给客户端的缓存命中率（0–100）。上游 Web 接口不提供 prompt cache
    // 统计，该值仅用于客户端展示，不影响实际计费。
    reportedCacheHitRate: 98.5,
  },
});

let loaded = false;
let config = clone(DEFAULT_CONFIG);
let configPath = null;
let configLoadError = null;

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function isPlainObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value);
}

function deepMerge(base, patch) {
  const result = clone(base);
  for (const [key, value] of Object.entries(patch || {})) {
    if (isPlainObject(value) && isPlainObject(result[key])) {
      result[key] = deepMerge(result[key], value);
    } else if (Array.isArray(value)) {
      result[key] = clone(value);
    } else if (value !== undefined) {
      result[key] = value;
    }
  }
  return result;
}

function parseBool(value, fallback) {
  if (value == null || value === '') return fallback;
  return ['true', '1', 'yes', 'on'].includes(String(value).trim().toLowerCase());
}

function parseIntValue(value, fallback, min = 0) {
  if (value == null || value === '') return fallback;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, parsed);
}

function parseFloatValue(value, fallback) {
  if (value == null || value === '') return fallback;
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function splitList(value) {
  return String(value || '')
    .split(',')
    .map(item => item.trim())
    .filter(Boolean);
}

function parseAccounts(value) {
  return splitList(value).map(item => {
    const [email, ...passwordParts] = item.split(':');
    const password = passwordParts.join(':');
    return email && password ? { email, password } : null;
  }).filter(Boolean);
}

function serializeAccounts(accounts = []) {
  return accounts
    .filter(item => item?.email && item?.password)
    .map(item => `${item.email}:${item.password}`)
    .join(',');
}

function uniqueStrings(values = []) {
  return [...new Set(values.map(value => String(value || '').trim()).filter(Boolean))];
}

function normalizeAccounts(accounts = []) {
  const seen = new Set();
  const normalized = [];
  for (const account of accounts || []) {
    const email = String(account?.email || '').trim();
    const password = String(account?.password || '').trim();
    if (!email || !password) continue;
    const key = `${email}\n${password}`;
    if (seen.has(key)) continue;
    seen.add(key);
    normalized.push({ email, password });
  }
  return normalized;
}

function normalizeApiKeys(apiKeys = []) {
  const seen = new Set();
  const normalized = [];
  for (const item of apiKeys || []) {
    const key = String(typeof item === 'string' ? item : item?.key || '').trim();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    normalized.push({
      name: String(typeof item === 'string' ? 'External API Key' : item?.name || 'External API Key').trim() || 'External API Key',
      key,
      createdAt: typeof item === 'object' && item?.createdAt ? String(item.createdAt) : '',
    });
  }
  return normalized;
}

function normalizeConfig(input) {
  const merged = deepMerge(DEFAULT_CONFIG, input || {});
  merged.version = 1;

  merged.server.apiKey = String(merged.server.apiKey || '').trim();
  merged.server.apiKeys = normalizeApiKeys(merged.server.apiKeys);
  merged.server.mergeThinking = Boolean(merged.server.mergeThinking);
  merged.server.enablePromptInjection = merged.server.enablePromptInjection !== false;
  merged.server.clientDebugLog = Boolean(merged.server.clientDebugLog);
  merged.server.clientDebugLogDir = String(merged.server.clientDebugLogDir || '').trim();
  merged.server.clientDebugLogMaxChars = parseIntValue(merged.server.clientDebugLogMaxChars, 200000, 1000);
  merged.server.systemFingerprint = String(merged.server.systemFingerprint || 'fp_omni_v1').trim() || 'fp_omni_v1';

  merged.runtime.sessionTtlSeconds = parseIntValue(merged.runtime.sessionTtlSeconds, 1800, 1);
  merged.runtime.enableConversationAffinity = Boolean(merged.runtime.enableConversationAffinity);
  merged.runtime.conversationTtlMs = parseIntValue(merged.runtime.conversationTtlMs, 1800000, 1000);
  merged.runtime.maxConversations = parseIntValue(merged.runtime.maxConversations, 500, 1);
  merged.runtime.enableFcErrorRetry = merged.runtime.enableFcErrorRetry !== false;
  merged.runtime.logDir = String(merged.runtime.logDir || '').trim();

  merged.deepseek.tokens = uniqueStrings(merged.deepseek.tokens);
  merged.deepseek.accounts = normalizeAccounts(merged.deepseek.accounts);
  merged.deepseek.maxConcurrentPerToken = parseIntValue(merged.deepseek.maxConcurrentPerToken, 2, 1);
  merged.deepseek.tokenDeadThreshold = parseIntValue(merged.deepseek.tokenDeadThreshold, 5, 1);
  merged.deepseek.healthCheckIntervalSeconds = parseIntValue(merged.deepseek.healthCheckIntervalSeconds, 600, 1);
  merged.deepseek.idleThresholdSeconds = parseIntValue(merged.deepseek.idleThresholdSeconds, 1800, 1);
  merged.deepseek.validateOnStartup = Boolean(merged.deepseek.validateOnStartup);
  merged.deepseek.prewarmSessions = Boolean(merged.deepseek.prewarmSessions);
  // 缓存命中率展示值：限制在 0–100，避免配置失误产生无意义数值。
  merged.deepseek.reportedCacheHitRate = Math.min(
    100,
    Math.max(0, Number.isFinite(Number(merged.deepseek.reportedCacheHitRate))
      ? Number(merged.deepseek.reportedCacheHitRate)
      : DEFAULT_CONFIG.deepseek.reportedCacheHitRate),
  );

  return merged;
}

function envConfig() {
  const singleDeepSeekToken = process.env.DS_TOKEN ? [process.env.DS_TOKEN] : [];
  const deepseekTokens = process.env.DS_TOKENS ? splitList(process.env.DS_TOKENS) : singleDeepSeekToken;

  return normalizeConfig({
    server: {
      apiKey: process.env.API_KEY || '',
      apiKeys: splitList(process.env.API_KEYS),
      mergeThinking: parseBool(process.env.MERGE_THINKING, DEFAULT_CONFIG.server.mergeThinking),
      enablePromptInjection: parseBool(process.env.ENABLE_PROMPT_INJECTION, DEFAULT_CONFIG.server.enablePromptInjection),
      clientDebugLog: parseBool(process.env.CLIENT_DEBUG_LOG, DEFAULT_CONFIG.server.clientDebugLog),
      clientDebugLogDir: process.env.CLIENT_DEBUG_LOG_DIR || '',
      clientDebugLogMaxChars: parseIntValue(process.env.CLIENT_DEBUG_LOG_MAX_CHARS, DEFAULT_CONFIG.server.clientDebugLogMaxChars, 1000),
      systemFingerprint: process.env.SYSTEM_FINGERPRINT || DEFAULT_CONFIG.server.systemFingerprint,
    },
    runtime: {
      sessionTtlSeconds: parseIntValue(process.env.SESSION_TTL, DEFAULT_CONFIG.runtime.sessionTtlSeconds, 1),
      enableConversationAffinity: parseBool(process.env.ENABLE_CONVERSATION_AFFINITY, DEFAULT_CONFIG.runtime.enableConversationAffinity),
      conversationTtlMs: parseIntValue(process.env.CONVERSATION_TTL_MS, DEFAULT_CONFIG.runtime.conversationTtlMs, 1000),
      maxConversations: parseIntValue(process.env.MAX_CONVERSATIONS, DEFAULT_CONFIG.runtime.maxConversations, 1),
      enableFcErrorRetry: parseBool(process.env.ENABLE_FC_ERROR_RETRY, DEFAULT_CONFIG.runtime.enableFcErrorRetry),
      logDir: process.env.LOG_DIR || '',
    },
    deepseek: {
      tokens: deepseekTokens,
      accounts: parseAccounts(process.env.DS_ACCOUNTS),
      maxConcurrentPerToken: parseIntValue(process.env.MAX_CONCURRENT_PER_TOKEN, DEFAULT_CONFIG.deepseek.maxConcurrentPerToken, 1),
      tokenDeadThreshold: parseIntValue(process.env.TOKEN_DEAD_THRESHOLD, DEFAULT_CONFIG.deepseek.tokenDeadThreshold, 1),
      healthCheckIntervalSeconds: parseIntValue(process.env.HEALTH_CHECK_INTERVAL, DEFAULT_CONFIG.deepseek.healthCheckIntervalSeconds, 1),
      idleThresholdSeconds: parseIntValue(process.env.IDLE_THRESHOLD, DEFAULT_CONFIG.deepseek.idleThresholdSeconds, 1),
      validateOnStartup: parseBool(process.env.DEEPSEEK_VALIDATE_ON_STARTUP, DEFAULT_CONFIG.deepseek.validateOnStartup),
      prewarmSessions: parseBool(process.env.DEEPSEEK_PREWARM_SESSIONS, DEFAULT_CONFIG.deepseek.prewarmSessions),
      reportedCacheHitRate: parseFloatValue(process.env.DEEPSEEK_REPORTED_CACHE_HIT_RATE, DEFAULT_CONFIG.deepseek.reportedCacheHitRate),
    },
  });
}

function resolveConfigPath() {
  if (process.env.ZHI2API_CONFIG_PATH) return resolve(process.env.ZHI2API_CONFIG_PATH);
  if (process.env.ZHI2API_DATA_DIR) return resolve(process.env.ZHI2API_DATA_DIR, 'config.json');
  return appRootPath('config.json');
}

function readDiskConfig(path) {
  if (!existsSync(path)) return {};
  const raw = readFileSync(path, 'utf8');
  return JSON.parse(raw || '{}');
}

export function loadConfig({ force = false } = {}) {
  if (loaded && !force) return config;

  configPath = resolveConfigPath();
  configLoadError = null;
  let disk = {};
  try {
    disk = readDiskConfig(configPath);
  } catch (error) {
    configLoadError = error.message;
    console.warn(`Failed to load config ${configPath}: ${error.message}`);
  }

  config = normalizeConfig(deepMerge(envConfig(), disk));
  loaded = true;
  return config;
}

function setEnv(name, value) {
  if (value == null || value === '') {
    delete process.env[name];
  } else {
    process.env[name] = String(value);
  }
}

export function applyConfigToProcessEnv() {
  const current = loadConfig();
  setEnv('API_KEY', current.server.apiKey);
  setEnv('API_KEYS', current.server.apiKeys.map(item => item.key).join(','));
  setEnv('MERGE_THINKING', current.server.mergeThinking ? 'true' : 'false');
  setEnv('ENABLE_PROMPT_INJECTION', current.server.enablePromptInjection ? 'true' : 'false');
  setEnv('CLIENT_DEBUG_LOG', current.server.clientDebugLog ? 'true' : 'false');
  setEnv('CLIENT_DEBUG_LOG_DIR', current.server.clientDebugLogDir);
  setEnv('CLIENT_DEBUG_LOG_MAX_CHARS', current.server.clientDebugLogMaxChars);
  setEnv('SYSTEM_FINGERPRINT', current.server.systemFingerprint);

  setEnv('SESSION_TTL', current.runtime.sessionTtlSeconds);
  setEnv('ENABLE_CONVERSATION_AFFINITY', current.runtime.enableConversationAffinity ? 'true' : 'false');
  setEnv('CONVERSATION_TTL_MS', current.runtime.conversationTtlMs);
  setEnv('MAX_CONVERSATIONS', current.runtime.maxConversations);
  setEnv('ENABLE_FC_ERROR_RETRY', current.runtime.enableFcErrorRetry ? 'true' : 'false');
  setEnv('LOG_DIR', current.runtime.logDir);

  setEnv('DS_TOKENS', current.deepseek.tokens.join(','));
  setEnv('DS_ACCOUNTS', serializeAccounts(current.deepseek.accounts));
  setEnv('MAX_CONCURRENT_PER_TOKEN', current.deepseek.maxConcurrentPerToken);
  setEnv('TOKEN_DEAD_THRESHOLD', current.deepseek.tokenDeadThreshold);
  setEnv('HEALTH_CHECK_INTERVAL', current.deepseek.healthCheckIntervalSeconds);
  setEnv('IDLE_THRESHOLD', current.deepseek.idleThresholdSeconds);
  setEnv('DEEPSEEK_VALIDATE_ON_STARTUP', current.deepseek.validateOnStartup ? 'true' : 'false');
  setEnv('DEEPSEEK_PREWARM_SESSIONS', current.deepseek.prewarmSessions ? 'true' : 'false');
}

export function getConfig() {
  return loadConfig();
}

export function getConfigPath() {
  loadConfig();
  return configPath;
}

export function getConfigLoadError() {
  loadConfig();
  return configLoadError;
}

export function getDataDir() {
  return process.env.ZHI2API_DATA_DIR || dirname(getConfigPath());
}

export function getLogDir() {
  return getConfig().runtime.logDir || resolve(getDataDir(), 'logs');
}

export function saveConfig(nextConfig = config) {
  const normalized = normalizeConfig(nextConfig);
  const path = getConfigPath();
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(normalized, null, 2)}\n`);
  config = normalized;
  loaded = true;
  applyConfigToProcessEnv();
  return config;
}

export function updateConfig(patch) {
  return saveConfig(deepMerge(getConfig(), patch));
}

export function updateChannelConfig(channel, payload) {
  if (!Object.prototype.hasOwnProperty.call(DEFAULT_CONFIG, channel)) {
    throw new Error(`Unsupported channel: ${channel}`);
  }
  return updateConfig({ [channel]: payload });
}

export function secretId(secret) {
  return createHash('sha256').update(String(secret || '')).digest('hex').slice(0, 16);
}

function maskSecret(secret) {
  const text = String(secret || '');
  if (!text) return '';
  if (text.length <= 8) return `${text.slice(0, 2)}***`;
  return `${text.slice(0, 4)}...${text.slice(-4)}`;
}

function publicSecrets(values = []) {
  return values.map(value => ({ id: secretId(value), label: maskSecret(value), configured: true }));
}

function publicApiKeys(values = []) {
  return values.map(value => ({
    id: secretId(value.key),
    name: value.name,
    label: maskSecret(value.key),
    createdAt: value.createdAt || '',
    configured: true,
  }));
}

function publicAccounts(accounts = []) {
  return accounts.map(account => ({
    id: secretId(`${account.email}:${account.password}`),
    email: account.email,
    hasPassword: Boolean(account.password),
  }));
}

export function getPublicConfig() {
  const current = getConfig();
  return {
    version: current.version,
    paths: {
      config: getConfigPath(),
      dataDir: getDataDir(),
      logDir: getLogDir(),
      clientDebugLogDir: current.server.clientDebugLogDir || resolve(getDataDir(), 'logs-debug'),
    },
    loadError: getConfigLoadError(),
    server: {
      apiKeyConfigured: Boolean(current.server.apiKey),
      apiKey: current.server.apiKey ? maskSecret(current.server.apiKey) : '',
      apiKeys: publicApiKeys(current.server.apiKeys),
      externalApiKeyCount: current.server.apiKeys.length + (current.server.apiKey ? 1 : 0),
      adminKeyAcceptedForApi: Boolean(current.server.apiKey),
      mergeThinking: current.server.mergeThinking,
      enablePromptInjection: current.server.enablePromptInjection,
      clientDebugLog: current.server.clientDebugLog,
      clientDebugLogDir: current.server.clientDebugLogDir,
      clientDebugLogMaxChars: current.server.clientDebugLogMaxChars,
      systemFingerprint: current.server.systemFingerprint,
    },
    runtime: {
      sessionTtlSeconds: current.runtime.sessionTtlSeconds,
      enableConversationAffinity: current.runtime.enableConversationAffinity,
      conversationTtlMs: current.runtime.conversationTtlMs,
      maxConversations: current.runtime.maxConversations,
      enableFcErrorRetry: current.runtime.enableFcErrorRetry,
      logDir: current.runtime.logDir,
    },
    deepseek: {
      authMode: current.deepseek.accounts.length > 0 ? 'account-pool' : 'token-pool',
      tokenCount: current.deepseek.tokens.length,
      tokens: current.deepseek.accounts.length > 0 ? [] : publicSecrets(current.deepseek.tokens),
      accounts: publicAccounts(current.deepseek.accounts),
      maxConcurrentPerToken: current.deepseek.maxConcurrentPerToken,
      tokenDeadThreshold: current.deepseek.tokenDeadThreshold,
      healthCheckIntervalSeconds: current.deepseek.healthCheckIntervalSeconds,
      idleThresholdSeconds: current.deepseek.idleThresholdSeconds,
      validateOnStartup: current.deepseek.validateOnStartup,
      prewarmSessions: current.deepseek.prewarmSessions,
      reportedCacheHitRate: current.deepseek.reportedCacheHitRate,
    },
  };
}

export function getPublicChannelConfig(channel) {
  const publicConfig = getPublicConfig();
  if (!Object.prototype.hasOwnProperty.call(publicConfig, channel)) {
    throw new Error(`Unsupported channel: ${channel}`);
  }
  return publicConfig[channel];
}

function generateApiKey() {
  return `sk-omni-${randomBytes(24).toString('hex')}`;
}

export function addServerApiKey(payload = {}) {
  const key = String(payload.key || '').trim() || generateApiKey();
  const name = String(payload.name || 'External API Key').trim() || 'External API Key';
  const current = getConfig();
  const next = clone(current);
  next.server.apiKeys.push({
    name,
    key,
    createdAt: new Date().toISOString(),
  });
  saveConfig(next);
  return { key, config: getPublicConfig().server };
}

export function removeServerApiKey(id) {
  const current = getConfig();
  const before = current.server.apiKeys.length;
  const next = clone(current);
  next.server.apiKeys = next.server.apiKeys.filter(item => secretId(item.key) !== id);
  if (next.server.apiKeys.length === before) return false;
  saveConfig(next);
  return true;
}

function safeEqualSecret(left, right) {
  const a = Buffer.from(String(left || ''));
  const b = Buffer.from(String(right || ''));
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export function getAcceptedApiKeys() {
  const current = getConfig();
  return uniqueStrings([
    current.server.apiKey,
    ...current.server.apiKeys.map(item => item.key),
  ]);
}

export function isAcceptedApiKey(value) {
  const keys = getAcceptedApiKeys();
  if (!keys.length) return true;
  return keys.some(key => safeEqualSecret(value, key));
}

export function addChannelCredential(channel, payload = {}) {
  const current = getConfig();
  const next = clone(current);
  if (channel === 'deepseek') {
    if (payload.type === 'account') {
      next.deepseek.accounts.push({ email: payload.email, password: payload.password });
    } else {
      next.deepseek.tokens.push(payload.token);
    }
  } else {
    throw new Error(`Unsupported channel: ${channel}`);
  }
  return saveConfig(next);
}

export function removeChannelCredential(channel, id) {
  const current = getConfig();
  const next = clone(current);
  let removed = false;

  function removeSecret(list) {
    const before = list.length;
    const filtered = list.filter(value => secretId(value) !== id);
    removed = removed || filtered.length !== before;
    return filtered;
  }

  function removeAccount(list) {
    const before = list.length;
    const filtered = list.filter(account => secretId(`${account.email}:${account.password}`) !== id);
    removed = removed || filtered.length !== before;
    return filtered;
  }

  if (channel === 'deepseek') {
    next.deepseek.tokens = removeSecret(next.deepseek.tokens);
    next.deepseek.accounts = removeAccount(next.deepseek.accounts);
  } else {
    throw new Error(`Unsupported channel: ${channel}`);
  }

  if (!removed) return false;
  saveConfig(next);
  return true;
}
