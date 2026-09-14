/**
 * Admin 路由
 *
 * 处理所有 /admin/* 端点
 * - Admin 面板 UI
 * - 统计信息 API
 * - 日志查询 API
 * - Token 管理 API
 */

import express from 'express';
import { srcPath } from '../utils/runtime-paths.js';
import { getPoolInfo, getTotalCapacity, addTokenToPool, loginAndAddToken, removeTokenFromPool, syncTokenPoolFromConfig, testDeepSeekToken, startHealthCheck, stopHealthCheck } from '../services/auth.js';
import { getSessionInfo } from '../services/session.js';
import { getConversationInfo } from '../services/conversation.js';
import { getQueueInfo } from '../services/queue.js';
import { filterLogs, getLogStats, readHistoricalLogs, readChatLogs, readRecentLogs, listLogDates } from '../middleware/logger.js';
import { getMetrics } from '../middleware/metrics.js';
import { DEEPSEEK_MODEL_MAP } from '../channels/deepseek/models.js';
import { GLM_MODEL_MAP } from '../channels/glm/models.js';
import { getGLMStatus } from '../channels/glm/index.js';
import { getConfig, getLogDir, getPublicChannelConfig, getPublicConfig, addServerApiKey, removeServerApiKey, addChannelCredential, removeChannelCredential, updateChannelConfig, updateConfig, secretId } from '../services/config-store.js';
import { authStatus, clearAdminSessionCookie, setAdminSessionCookie, verifyAdminPassword } from '../services/admin-auth.js';
import { glmTokenManager } from '../channels/glm/runner.js';

const router = express.Router();

// 用于计算 uptime
const startTime = Date.now();

function envListCount(name) {
  return String(process.env[name] || '').split(',').map(v => v.trim()).filter(Boolean).length;
}

function channelForModel(model) {
  if (Object.prototype.hasOwnProperty.call(DEEPSEEK_MODEL_MAP, model)) return 'deepseek';
  if (Object.prototype.hasOwnProperty.call(GLM_MODEL_MAP, model)) return 'glm';
  return 'unknown';
}

function channelForLogEntry(entry) {
  const fromModel = entry.channel && entry.channel !== 'unknown' ? entry.channel : channelForModel(entry.model);
  if (fromModel !== 'unknown') return fromModel;
  const path = String(entry.path || '');
  return path.startsWith('/v1/') || path === '/models' || path === '/messages' || path === '/chat/completions'
    ? 'api'
    : 'unknown';
}

function modelCatalog() {
  const deepseekModels = Object.keys(DEEPSEEK_MODEL_MAP).map(id => ({
    id,
    channel: 'deepseek',
    owned_by: 'deepseek',
    capabilities: { text: true, thinking: id.includes('pro'), document: id.includes('flash'), vision: id.includes('flash') },
  }));
  const glmModels = Object.entries(GLM_MODEL_MAP).map(([id, config]) => ({
    id,
    channel: 'glm',
    owned_by: 'zhipu',
    capabilities: { text: true, thinking: true, search: Boolean(config.search), document: true, vision: true, audio: true, video: true },
  }));
  return [...deepseekModels, ...glmModels];
}

function summarizeRecentErrors() {
  const errors = readRecentLogs(200, { status: 'error' });
  const byChannel = new Map();
  for (const entry of errors) {
    const channel = entry.channel || channelForModel(entry.model);
    const current = byChannel.get(channel) || { count: 0, last: null };
    current.count++;
    if (!current.last || new Date(entry.time) > new Date(current.last.time)) current.last = entry;
    byChannel.set(channel, current);
  }
  return byChannel;
}

function summarizeModelMetrics() {
  const metrics = getMetrics();
  const byChannel = {};
  for (const [model, data] of Object.entries(metrics.perModel || {})) {
    const channel = channelForModel(model);
    if (!byChannel[channel]) byChannel[channel] = { requests: 0, errors: 0, rpm: 0, tokenSpeed: 0, models: 0 };
    byChannel[channel].requests += data.requests || 0;
    byChannel[channel].errors += data.errors || 0;
    byChannel[channel].rpm += data.rpm || 0;
    byChannel[channel].tokenSpeed += data.tokenSpeed || 0;
    byChannel[channel].models++;
  }
  for (const item of Object.values(byChannel)) {
    item.tokenSpeed = item.models ? Math.round(item.tokenSpeed / item.models) : 0;
  }
  return { metrics, byChannel };
}

function buildChannels() {
  const config = getConfig();
  const deepseekPool = getPoolInfo();
  const deepseekAlive = deepseekPool.filter(item => !item.dead && item.token !== 'NONE').length;
  const glmStatus = getGLMStatus();
  const errors = summarizeRecentErrors();
  const { byChannel } = summarizeModelMetrics();

  const channels = [
    {
      id: 'deepseek',
      name: 'DeepSeek',
      configured: config.deepseek.tokens.length + config.deepseek.accounts.length > 0,
      credentialCount: deepseekPool.length,
      availableCount: deepseekAlive,
      activeRequests: deepseekPool.reduce((sum, item) => sum + (item.activeRequests || 0), 0),
      capacity: getTotalCapacity(),
      mode: config.deepseek.accounts.length > 0 ? 'account-pool' : 'token-pool',
      queue: getQueueInfo(),
      detail: deepseekPool,
    },
    {
      id: 'glm',
      name: 'GLM',
      configured: glmStatus.auth.configuredRefreshTokens > 0,
      credentialCount: glmStatus.auth.configuredRefreshTokens,
      availableCount: glmStatus.auth.configuredRefreshTokens || glmStatus.auth.cached.length || (glmStatus.auth.mode === 'guest' ? 1 : 0),
      activeRequests: glmStatus.auth.pendingRefresh ? 1 : 0,
      capacity: glmStatus.auth.configuredRefreshTokens || 1,
      mode: glmStatus.auth.mode,
      detail: glmStatus.auth,
    },
  ];

  return channels.map(channel => {
    const errorSummary = errors.get(channel.id);
    const usage = byChannel[channel.id] || { requests: 0, errors: 0, rpm: 0, tokenSpeed: 0 };
    const status = !channel.configured && channel.id !== 'glm'
      ? 'unconfigured'
      : channel.availableCount > 0 ? 'healthy' : 'degraded';
    return {
      ...channel,
      status,
      recentErrors: errorSummary?.count || 0,
      lastError: errorSummary?.last || null,
      usage,
    };
  });
}

function decorateLog(entry) {
  const level = entry.status >= 500 ? 'ERROR' : entry.status >= 400 ? 'WARN' : 'SUCCESS';
  const channel = channelForLogEntry(entry);
  const model = entry.model && entry.model !== '-' ? entry.model : '-';
  return {
    ...entry,
    channel,
    level,
    model,
    message: `${entry.method} ${entry.path} channel=${channel} model=${model} status=${entry.status} duration=${entry.duration}ms`,
  };
}

function logFiltersFromQuery(query) {
  return {
    channel: query.channel || 'all',
    model: query.model || 'all',
    status: query.status || 'all',
    search: query.search || '',
    apiOnly: true,
    excludeUnknown: false,
  };
}

const CHANNEL_IDS = new Set(['deepseek', 'glm']);

function ensureChannel(channel) {
  if (!CHANNEL_IDS.has(channel)) {
    const error = new Error(`Unsupported channel: ${channel}`);
    error.statusCode = 404;
    throw error;
  }
}

function applyChannelRuntime(channel) {
  if (channel === 'deepseek') {
    syncTokenPoolFromConfig();
    stopHealthCheck();
    startHealthCheck();
  }
  if (channel === 'glm') glmTokenManager.configure();
}

function jsonError(res, error, fallbackStatus = 500) {
  res.status(error.statusCode || fallbackStatus).json({ error: { message: error.message } });
}

// ============= 静态资源服务 =============

// SPA 构建产物（Vite 输出 src/admin/dist）。前端 bundle 本身不含机密，
// 登录页就在其中，因此静态资源免鉴权；真正的数据保护在 /admin/api/* 与
// /performance/api/* 的鉴权中间件上（见 server.js）。
router.use('/assets', express.static(srcPath('admin', 'dist', 'assets')));

// ============= Admin 面板 UI =============

// 前端使用 hash 路由（#dashboard / #channels ...），服务端只需返回入口。
router.get('/', (req, res) => {
  res.sendFile(srcPath('admin', 'dist', 'index.html'));
});

// ============= 鉴权与配置 API =============

router.get('/api/auth/status', (req, res) => {
  res.json(authStatus(req));
});

router.post('/api/auth/login', (req, res) => {
  const { apiKey } = req.body || {};
  if (!getConfig().server.apiKey) {
    return res.json({ success: true, ...authStatus(req) });
  }
  if (!apiKey || !verifyAdminPassword(String(apiKey))) {
    return res.status(401).json({ error: { message: 'Invalid API key' } });
  }
  setAdminSessionCookie(res);
  res.json({ success: true, authenticated: true });
});

router.post('/api/auth/logout', (_req, res) => {
  clearAdminSessionCookie(res);
  res.json({ success: true });
});

router.get('/api/config', (_req, res) => {
  res.json({ config: getPublicConfig() });
});

router.patch('/api/config', (req, res) => {
  try {
    const saved = updateConfig(req.body || {});
    syncTokenPoolFromConfig();
    stopHealthCheck();
    startHealthCheck();
    glmTokenManager.configure();
    res.json({ success: true, config: getPublicConfig(), saved: Boolean(saved) });
  } catch (error) {
    jsonError(res, error);
  }
});

router.post('/api/server/api-keys', (req, res) => {
  try {
    const result = addServerApiKey(req.body || {});
    res.json({ success: true, key: result.key, config: result.config });
  } catch (error) {
    jsonError(res, error, 400);
  }
});

router.delete('/api/server/api-keys/:id', (req, res) => {
  try {
    const removed = removeServerApiKey(req.params.id);
    if (!removed) return res.status(404).json({ error: { message: 'api key not found' } });
    res.json({ success: true, config: getPublicConfig().server });
  } catch (error) {
    jsonError(res, error);
  }
});

router.get('/api/channels/:channel/config', (req, res) => {
  try {
    const { channel } = req.params;
    ensureChannel(channel);
    res.json({ channel, config: getPublicChannelConfig(channel) });
  } catch (error) {
    jsonError(res, error);
  }
});

router.put('/api/channels/:channel/config', (req, res) => {
  try {
    const { channel } = req.params;
    ensureChannel(channel);
    updateChannelConfig(channel, { ...getConfig()[channel], ...(req.body || {}) });
    applyChannelRuntime(channel);
    res.json({ success: true, channel, config: getPublicChannelConfig(channel) });
  } catch (error) {
    jsonError(res, error);
  }
});

router.post('/api/channels/:channel/credentials', (req, res) => {
  try {
    const { channel } = req.params;
    ensureChannel(channel);
    addChannelCredential(channel, req.body || {});
    applyChannelRuntime(channel);
    res.json({ success: true, channel, config: getPublicChannelConfig(channel) });
  } catch (error) {
    jsonError(res, error, 400);
  }
});

router.delete('/api/channels/:channel/credentials/:id', (req, res) => {
  try {
    const { channel, id } = req.params;
    ensureChannel(channel);
    const removed = removeChannelCredential(channel, id);
    if (!removed) return res.status(404).json({ error: { message: 'credential not found' } });
    applyChannelRuntime(channel);
    res.json({ success: true, channel, config: getPublicChannelConfig(channel) });
  } catch (error) {
    jsonError(res, error);
  }
});

function secretLabel(value) {
  const text = String(value || '');
  return text.length <= 12 ? text : `${text.slice(0, 6)}...${text.slice(-4)}`;
}

router.post('/api/channels/:channel/test', async (req, res) => {
  try {
    const { channel } = req.params;
    ensureChannel(channel);
    const config = getConfig();
    const results = [];
    const removedIds = [];

    if (channel === 'deepseek') {
      const { testDeepSeekToken, getDeepSeekPoolEntries, loginAndAddToken } = await import('../services/auth.js');
      let pool = getDeepSeekPoolEntries();
      const needsLogin = pool.length === 0 || pool.some(entry => !entry.token);
      if (needsLogin && config.deepseek.accounts.length > 0) {
        for (const account of config.deepseek.accounts) {
          try {
            await loginAndAddToken(String(account.email), String(account.password));
            results.push({ label: account.email, success: true, message: '账号登录成功，Token 已获取' });
          } catch (err) {
            // 不删除账号 — 登录失败通常是上游 API 格式变更导致，不是账号无效
            results.push({ label: account.email, success: false, message: `登录失败: ${err.message}（账号已保留）` });
          }
        }
        pool = getDeepSeekPoolEntries();
      }
      for (const entry of pool) {
        if (!entry.token) {
          results.push({ label: entry.email || 'unknown', success: false, message: '无可用 Token（等待自动登录）' });
          continue;
        }
        try {
          const result = await testDeepSeekToken(entry.token);
          if (result.valid) {
            results.push({ label: entry.email || entry.token.replace(/^(.{6}).*(.{4})$/, '$1...$2'), success: true, message: '有效' });
          } else {
            const id = secretId(entry.token);
            removeChannelCredential('deepseek', id);
            removedIds.push(id);
            results.push({ label: entry.email || entry.token.replace(/^(.{6}).*(.{4})$/, '$1...$2'), success: false, message: '无效，凭据已删除' });
          }
        } catch (err) {
          results.push({ label: entry.email || entry.token, success: false, message: err.message });
        }
      }
      return res.json({ success: results.some(r => r.success), channel, results, removed: removedIds.length > 0 });
    }

    if (channel === 'glm') {
      for (const rt of config.glm.refreshTokens || []) {
        try {
          // 直接测这一条 refresh token——getAccessToken() 会在 token 失效时
          // 静默降级访客模式，导致无效凭据也报"成功"。
          const ok = await glmTokenManager.testRefreshToken(rt);
          results.push({ label: secretLabel(rt), success: ok, message: ok ? '访问令牌获取成功' : '无法获取访问令牌' });
          if (!ok) {
            removeChannelCredential('glm', secretId(rt));
          }
        } catch (err) {
          // 仅在上游明确拒绝时删除凭据；网络类错误保留凭据，避免离线点测试把凭据清空。
          if (/GLM token refresh failed/i.test(err.message)) {
            removeChannelCredential('glm', secretId(rt));
            results.push({ label: secretLabel(rt), success: false, message: `凭据无效，已删除: ${err.message}` });
          } else {
            results.push({ label: secretLabel(rt), success: false, message: `测试失败（凭据已保留）: ${err.message}` });
          }
        }
      }
      if (!results.length && config.glm.guestMode) {
        results.push({ label: '访客模式', success: true, message: '访客模式已启用，无需配置凭据' });
      }
      return res.json({ success: results.some(r => r.success), channel, results });
    }

    res.json({ success: true, channel, results });
  } catch (error) {
    jsonError(res, error);
  }
});

// ============= 统计信息 API =============

router.get('/api/stats', (req, res) => {
  const uptimeSeconds = Math.floor((Date.now() - startTime) / 1000);
  const channels = buildChannels();
  const proxyUrl = process.env.HTTPS_PROXY || process.env.https_proxy || process.env.HTTP_PROXY || process.env.http_proxy || null;
  res.json({
    status: 'ok',
    version: '1.0.0',
    uptimeSeconds,
    serverUrl: `${req.protocol}://${req.headers.host}`,
    proxyUrl,
    pool: getPoolInfo(),
    totalCapacity: getTotalCapacity(),
    queue: getQueueInfo(),
    sessions: getSessionInfo(),
    conversations: {
      ...getConversationInfo(),
      affinityEnabled: getConfig().runtime.enableConversationAffinity,
    },
    logStats: getLogStats(),
    channels,
    metrics: getMetrics(),
    config: {
      paths: getPublicConfig().paths,
      logDir: getLogDir(),
    },
  });
});

router.get('/api/health', (req, res) => {
  const channels = buildChannels();
  const hasDegraded = channels.some(channel => channel.status === 'degraded');
  const hasHealthy = channels.some(channel => channel.status === 'healthy');
  res.json({
    status: hasHealthy ? (hasDegraded ? 'degraded' : 'healthy') : 'unavailable',
    version: '1.0.0',
    uptimeSeconds: Math.floor((Date.now() - startTime) / 1000),
    queue: getQueueInfo(),
    totalCapacity: getTotalCapacity(),
    channels,
    metrics: getMetrics(),
  });
});

router.get('/api/channels', (req, res) => {
  res.json({ channels: buildChannels() });
});

router.get('/api/models', (req, res) => {
  res.json({ models: modelCatalog() });
});

// ============= 日志查询 API =============

router.get('/api/logs', (req, res) => {
  const count = Math.min(parseInt(req.query.count) || 50, 200);
  const logs = readRecentLogs(count, logFiltersFromQuery(req.query)).map(decorateLog);
  res.json({ logs, stats: getLogStats() });
});

router.get('/api/logs/dates', (req, res) => {
  res.json({ dates: listLogDates() });
});

router.get('/api/logs/history', (req, res) => {
  const { date } = req.query;
  if (!date) return res.status(400).json({ error: { message: 'date param required (YYYY-MM-DD)' } });
  const count = Math.min(parseInt(req.query.count) || 100, 10000);
  const logs = filterLogs(readHistoricalLogs(date, count), logFiltersFromQuery(req.query)).slice().reverse().map(decorateLog);
  res.json({ logs });
});

router.get('/api/logs/chats', (req, res) => {
  const date = req.query.date || new Date().toISOString().slice(0, 10);
  const count = Math.min(parseInt(req.query.count) || 100, 10000);
  res.json({ chats: readChatLogs(date, count), total: count });
});

// ============= Token 管理 API =============

router.post('/api/token/add', async (req, res) => {
  const { token } = req.body;
  if (!token || typeof token !== 'string') {
    return res.status(400).json({ error: { message: 'token required' } });
  }
  try {
    const added = await addTokenToPool(token);
    res.json({ success: true, visionCapable: added.visionCapable, validated: false, message: 'Token 已保存，尚未验证。' });
  } catch (err) {
    res.status(500).json({ error: { message: err.message } });
  }
});

router.post('/api/token/login', async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) {
    return res.status(400).json({ error: { message: 'email and password required' } });
  }
  try {
    const token = await loginAndAddToken(email, password);
    res.json({ success: true, token: token.slice(0, 12) + '...' });
  } catch (err) {
    res.status(500).json({ error: { message: err.message } });
  }
});

router.post('/api/token/remove', (req, res) => {
  const { tokenPrefix } = req.body;
  if (!tokenPrefix || typeof tokenPrefix !== 'string') {
    return res.status(400).json({ error: { message: 'tokenPrefix required' } });
  }
  const removed = removeTokenFromPool(tokenPrefix);
  if (!removed) return res.status(404).json({ error: { message: 'token not found' } });
  res.json({ success: true });
});

export default router;
