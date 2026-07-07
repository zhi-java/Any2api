import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { dirname, resolve } from 'path';
import { createHash } from 'crypto';
import { appRootPath } from '../utils/runtime-paths.js';

const DEFAULT_CONFIG = Object.freeze({
  version: 1,
  server: {
    apiKey: '',
    mergeThinking: false,
    enablePromptInjection: true,
    clientDebugLog: false,
    clientDebugLogMaxChars: 200000,
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
  },
  glm: {
    refreshTokens: [],
    guestMode: true,
  },
  qwen: {
    tokens: [],
    accounts: [],
    maxConcurrentPerToken: 1,
    maxQueueSize: 100,
    queueTimeoutMs: 30000,
    accountMinIntervalMs: 1200,
    rateLimitBaseCooldownMs: 600000,
    rateLimitMaxCooldownMs: 3600000,
    maxTokenErrors: 3,
  },
  kimi: {
    authTokens: [],
    textAttachmentThresholdBytes: 450000,
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

function normalizeConfig(input) {
  const merged = deepMerge(DEFAULT_CONFIG, input || {});
  merged.version = 1;

  merged.server.apiKey = String(merged.server.apiKey || '').trim();
  merged.server.mergeThinking = Boolean(merged.server.mergeThinking);
  merged.server.enablePromptInjection = merged.server.enablePromptInjection !== false;
  merged.server.clientDebugLog = Boolean(merged.server.clientDebugLog);
  merged.server.clientDebugLogMaxChars = parseIntValue(merged.server.clientDebugLogMaxChars, 200000, 1000);

  merged.deepseek.tokens = uniqueStrings(merged.deepseek.tokens);
  merged.deepseek.accounts = normalizeAccounts(merged.deepseek.accounts);
  merged.deepseek.maxConcurrentPerToken = parseIntValue(merged.deepseek.maxConcurrentPerToken, 2, 1);
  merged.deepseek.tokenDeadThreshold = parseIntValue(merged.deepseek.tokenDeadThreshold, 5, 1);
  merged.deepseek.healthCheckIntervalSeconds = parseIntValue(merged.deepseek.healthCheckIntervalSeconds, 600, 1);
  merged.deepseek.idleThresholdSeconds = parseIntValue(merged.deepseek.idleThresholdSeconds, 1800, 1);
  merged.deepseek.validateOnStartup = Boolean(merged.deepseek.validateOnStartup);
  merged.deepseek.prewarmSessions = Boolean(merged.deepseek.prewarmSessions);

  merged.glm.refreshTokens = uniqueStrings(merged.glm.refreshTokens);
  merged.glm.guestMode = merged.glm.guestMode !== false;

  merged.qwen.tokens = uniqueStrings(merged.qwen.tokens);
  merged.qwen.accounts = normalizeAccounts(merged.qwen.accounts);
  merged.qwen.maxConcurrentPerToken = parseIntValue(merged.qwen.maxConcurrentPerToken, 1, 1);
  merged.qwen.maxQueueSize = parseIntValue(merged.qwen.maxQueueSize, 100, 0);
  merged.qwen.queueTimeoutMs = parseIntValue(merged.qwen.queueTimeoutMs, 30000, 1000);
  merged.qwen.accountMinIntervalMs = parseIntValue(merged.qwen.accountMinIntervalMs, 1200, 0);
  merged.qwen.rateLimitBaseCooldownMs = parseIntValue(merged.qwen.rateLimitBaseCooldownMs, 600000, 1000);
  merged.qwen.rateLimitMaxCooldownMs = parseIntValue(merged.qwen.rateLimitMaxCooldownMs, 3600000, 1000);
  merged.qwen.maxTokenErrors = parseIntValue(merged.qwen.maxTokenErrors, 3, 1);

  merged.kimi.authTokens = uniqueStrings(merged.kimi.authTokens);
  merged.kimi.textAttachmentThresholdBytes = parseIntValue(merged.kimi.textAttachmentThresholdBytes, 450000, 1);

  return merged;
}

function envConfig() {
  const singleDeepSeekToken = process.env.DS_TOKEN ? [process.env.DS_TOKEN] : [];
  const deepseekTokens = process.env.DS_TOKENS ? splitList(process.env.DS_TOKENS) : singleDeepSeekToken;
  const glmTokens = process.env.GLM_REFRESH_TOKENS
    ? splitList(process.env.GLM_REFRESH_TOKENS)
    : splitList(process.env.GLM_REFRESH_TOKEN);
  const kimiTokens = process.env.KIMI_AUTH_TOKENS
    ? splitList(process.env.KIMI_AUTH_TOKENS)
    : splitList(process.env.KIMI_AUTH_TOKEN);

  return normalizeConfig({
    server: {
      apiKey: process.env.API_KEY || '',
      mergeThinking: parseBool(process.env.MERGE_THINKING, DEFAULT_CONFIG.server.mergeThinking),
      enablePromptInjection: parseBool(process.env.ENABLE_PROMPT_INJECTION, DEFAULT_CONFIG.server.enablePromptInjection),
      clientDebugLog: parseBool(process.env.CLIENT_DEBUG_LOG, DEFAULT_CONFIG.server.clientDebugLog),
      clientDebugLogMaxChars: parseIntValue(process.env.CLIENT_DEBUG_LOG_MAX_CHARS, DEFAULT_CONFIG.server.clientDebugLogMaxChars, 1000),
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
    },
    glm: {
      refreshTokens: glmTokens,
      guestMode: parseBool(process.env.GLM_GUEST_MODE, DEFAULT_CONFIG.glm.guestMode),
    },
    qwen: {
      tokens: splitList(process.env.QWEN_TOKENS),
      accounts: parseAccounts(process.env.QWEN_ACCOUNTS),
      maxConcurrentPerToken: parseIntValue(process.env.QWEN_MAX_CONCURRENT_PER_TOKEN || process.env.MAX_CONCURRENT_PER_TOKEN, DEFAULT_CONFIG.qwen.maxConcurrentPerToken, 1),
      maxQueueSize: parseIntValue(process.env.QWEN_MAX_QUEUE_SIZE || process.env.MAX_QUEUE_SIZE, DEFAULT_CONFIG.qwen.maxQueueSize, 0),
      queueTimeoutMs: parseIntValue(process.env.QWEN_QUEUE_TIMEOUT_MS || process.env.QUEUE_TIMEOUT_MS, DEFAULT_CONFIG.qwen.queueTimeoutMs, 1000),
      accountMinIntervalMs: parseIntValue(process.env.QWEN_ACCOUNT_MIN_INTERVAL_MS || process.env.ACCOUNT_MIN_INTERVAL_MS, DEFAULT_CONFIG.qwen.accountMinIntervalMs, 0),
      rateLimitBaseCooldownMs: parseIntValue(process.env.QWEN_RATE_LIMIT_BASE_COOLDOWN_MS || process.env.RATE_LIMIT_BASE_COOLDOWN_MS, DEFAULT_CONFIG.qwen.rateLimitBaseCooldownMs, 1000),
      rateLimitMaxCooldownMs: parseIntValue(process.env.QWEN_RATE_LIMIT_MAX_COOLDOWN_MS || process.env.RATE_LIMIT_MAX_COOLDOWN_MS, DEFAULT_CONFIG.qwen.rateLimitMaxCooldownMs, 1000),
      maxTokenErrors: parseIntValue(process.env.QWEN_MAX_TOKEN_ERRORS || process.env.MAX_TOKEN_ERRORS, DEFAULT_CONFIG.qwen.maxTokenErrors, 1),
    },
    kimi: {
      authTokens: kimiTokens,
      textAttachmentThresholdBytes: parseIntValue(process.env.KIMI_TEXT_ATTACHMENT_THRESHOLD_BYTES, DEFAULT_CONFIG.kimi.textAttachmentThresholdBytes, 1),
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
  setEnv('MERGE_THINKING', current.server.mergeThinking ? 'true' : 'false');
  setEnv('ENABLE_PROMPT_INJECTION', current.server.enablePromptInjection ? 'true' : 'false');
  setEnv('CLIENT_DEBUG_LOG', current.server.clientDebugLog ? 'true' : 'false');
  setEnv('CLIENT_DEBUG_LOG_MAX_CHARS', current.server.clientDebugLogMaxChars);

  setEnv('DS_TOKENS', current.deepseek.tokens.join(','));
  setEnv('DS_ACCOUNTS', serializeAccounts(current.deepseek.accounts));
  setEnv('MAX_CONCURRENT_PER_TOKEN', current.deepseek.maxConcurrentPerToken);
  setEnv('TOKEN_DEAD_THRESHOLD', current.deepseek.tokenDeadThreshold);
  setEnv('HEALTH_CHECK_INTERVAL', current.deepseek.healthCheckIntervalSeconds);
  setEnv('IDLE_THRESHOLD', current.deepseek.idleThresholdSeconds);
  setEnv('DEEPSEEK_VALIDATE_ON_STARTUP', current.deepseek.validateOnStartup ? 'true' : 'false');
  setEnv('DEEPSEEK_PREWARM_SESSIONS', current.deepseek.prewarmSessions ? 'true' : 'false');

  setEnv('GLM_REFRESH_TOKENS', current.glm.refreshTokens.join(','));
  setEnv('GLM_GUEST_MODE', current.glm.guestMode ? 'true' : 'false');

  setEnv('QWEN_TOKENS', current.qwen.tokens.join(','));
  setEnv('QWEN_ACCOUNTS', serializeAccounts(current.qwen.accounts));
  setEnv('QWEN_MAX_CONCURRENT_PER_TOKEN', current.qwen.maxConcurrentPerToken);
  setEnv('QWEN_MAX_QUEUE_SIZE', current.qwen.maxQueueSize);
  setEnv('QWEN_QUEUE_TIMEOUT_MS', current.qwen.queueTimeoutMs);
  setEnv('QWEN_ACCOUNT_MIN_INTERVAL_MS', current.qwen.accountMinIntervalMs);
  setEnv('QWEN_RATE_LIMIT_BASE_COOLDOWN_MS', current.qwen.rateLimitBaseCooldownMs);
  setEnv('QWEN_RATE_LIMIT_MAX_COOLDOWN_MS', current.qwen.rateLimitMaxCooldownMs);
  setEnv('QWEN_MAX_TOKEN_ERRORS', current.qwen.maxTokenErrors);

  setEnv('KIMI_AUTH_TOKENS', current.kimi.authTokens.join(','));
  setEnv('KIMI_TEXT_ATTACHMENT_THRESHOLD_BYTES', current.kimi.textAttachmentThresholdBytes);
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
  return process.env.LOG_DIR || resolve(getDataDir(), 'logs');
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
      clientDebugLogDir: process.env.CLIENT_DEBUG_LOG_DIR || resolve(getDataDir(), 'logs-debug'),
    },
    loadError: getConfigLoadError(),
    server: {
      apiKeyConfigured: Boolean(current.server.apiKey),
      apiKey: current.server.apiKey ? maskSecret(current.server.apiKey) : '',
      mergeThinking: current.server.mergeThinking,
      enablePromptInjection: current.server.enablePromptInjection,
      clientDebugLog: current.server.clientDebugLog,
      clientDebugLogMaxChars: current.server.clientDebugLogMaxChars,
    },
    deepseek: {
      tokens: publicSecrets(current.deepseek.tokens),
      accounts: publicAccounts(current.deepseek.accounts),
      maxConcurrentPerToken: current.deepseek.maxConcurrentPerToken,
      tokenDeadThreshold: current.deepseek.tokenDeadThreshold,
      healthCheckIntervalSeconds: current.deepseek.healthCheckIntervalSeconds,
      idleThresholdSeconds: current.deepseek.idleThresholdSeconds,
      validateOnStartup: current.deepseek.validateOnStartup,
      prewarmSessions: current.deepseek.prewarmSessions,
    },
    glm: {
      refreshTokens: publicSecrets(current.glm.refreshTokens),
      guestMode: current.glm.guestMode,
    },
    qwen: {
      tokens: publicSecrets(current.qwen.tokens),
      accounts: publicAccounts(current.qwen.accounts),
      maxConcurrentPerToken: current.qwen.maxConcurrentPerToken,
      maxQueueSize: current.qwen.maxQueueSize,
      queueTimeoutMs: current.qwen.queueTimeoutMs,
      accountMinIntervalMs: current.qwen.accountMinIntervalMs,
      rateLimitBaseCooldownMs: current.qwen.rateLimitBaseCooldownMs,
      rateLimitMaxCooldownMs: current.qwen.rateLimitMaxCooldownMs,
      maxTokenErrors: current.qwen.maxTokenErrors,
    },
    kimi: {
      authTokens: publicSecrets(current.kimi.authTokens),
      textAttachmentThresholdBytes: current.kimi.textAttachmentThresholdBytes,
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

export function addChannelCredential(channel, payload = {}) {
  const current = getConfig();
  const next = clone(current);
  if (channel === 'deepseek') {
    if (payload.type === 'account') {
      next.deepseek.accounts.push({ email: payload.email, password: payload.password });
    } else {
      next.deepseek.tokens.push(payload.token);
    }
  } else if (channel === 'glm') {
    next.glm.refreshTokens.push(payload.refreshToken || payload.token);
    next.glm.guestMode = next.glm.refreshTokens.length === 0;
  } else if (channel === 'qwen') {
    if (payload.type === 'account') {
      next.qwen.accounts.push({ email: payload.email, password: payload.password });
    } else {
      next.qwen.tokens.push(payload.token);
    }
  } else if (channel === 'kimi') {
    next.kimi.authTokens.push(payload.token);
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
  } else if (channel === 'glm') {
    next.glm.refreshTokens = removeSecret(next.glm.refreshTokens);
    next.glm.guestMode = next.glm.refreshTokens.length === 0;
  } else if (channel === 'qwen') {
    next.qwen.tokens = removeSecret(next.qwen.tokens);
    next.qwen.accounts = removeAccount(next.qwen.accounts);
  } else if (channel === 'kimi') {
    next.kimi.authTokens = removeSecret(next.kimi.authTokens);
  } else {
    throw new Error(`Unsupported channel: ${channel}`);
  }

  if (!removed) return false;
  saveConfig(next);
  return true;
}
