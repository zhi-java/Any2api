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
import { appVersion, srcPath } from '../utils/runtime-paths.js';
import { getPoolInfo, getTotalCapacity, addTokenToPool, loginAndAddToken, removeTokenFromPool, syncTokenPoolFromConfig, testDeepSeekToken, startHealthCheck, stopHealthCheck, setCredentialDisabledById, disableTokenByTokenString, getCredentialRuntimeStatus } from '../services/auth.js';
import { getSessionInfo } from '../services/session.js';
import { getConversationInfo } from '../services/conversation.js';
import { getQueueInfo } from '../services/queue.js';
import { getLogStats, readRecentLogs } from '../middleware/logger.js';
import { getMetrics } from '../middleware/metrics.js';
import { DEEPSEEK_MODEL_MAP } from '../channels/deepseek/models.js';
import { getConfig, getLogDir, getPublicChannelConfig, getPublicConfig, addServerApiKey, removeServerApiKey, addChannelCredential, removeChannelCredential, updateChannelConfig, updateConfig } from '../services/config-store.js';
import { authStatus, clearAdminSessionCookie, setAdminSessionCookie, verifyAdminPassword } from '../services/admin-auth.js';

const router = express.Router();

// 用于计算 uptime
const startTime = Date.now();

function envListCount(name) {
  return String(process.env[name] || '').split(',').map(v => v.trim()).filter(Boolean).length;
}

function channelForModel(model) {
  if (Object.prototype.hasOwnProperty.call(DEEPSEEK_MODEL_MAP, model)) return 'deepseek';
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
  // DeepSeek 上游已合并模型能力：单一模型同时具备思考、文档与视觉能力。
  return Object.keys(DEEPSEEK_MODEL_MAP).map(id => ({
    id,
    channel: 'deepseek',
    owned_by: 'deepseek',
    capabilities: { text: true, thinking: true, document: true, vision: true },
  }));
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
  const deepseekAlive = deepseekPool.filter(item => !item.disabled && item.token !== 'NONE').length;
  const deepseekDisabled = deepseekPool.filter(item => item.disabled).length;
  // 「待登录」= 已配置但尚未取得 token 且未禁用。单列出来是为了让概览与
  // 凭据面板能用同一套口径解释"为什么可用数小于总数"。
  const deepseekPending = deepseekPool.filter(item => !item.disabled && item.token === 'NONE').length;
  const errors = summarizeRecentErrors();
  const { byChannel } = summarizeModelMetrics();

  const channels = [
    {
      id: 'deepseek',
      name: 'DeepSeek',
      configured: config.deepseek.tokens.length + config.deepseek.accounts.length > 0,
      // credentialCount 为**总数（含禁用）**，这样前端能表达"可用 N / 共 M"；
      // 禁用数单列，便于一眼看出有多少凭据被风控摘除。
      credentialCount: deepseekPool.length,
      availableCount: deepseekAlive,
      disabledCount: deepseekDisabled,
      pendingCount: deepseekPending,
      activeRequests: deepseekPool.reduce((sum, item) => sum + (item.activeRequests || 0), 0),
      capacity: getTotalCapacity(),
      mode: config.deepseek.accounts.length > 0 ? 'account-pool' : 'token-pool',
      queue: getQueueInfo(),
      detail: deepseekPool,
    },
  ];

  return channels.map(channel => {
    const errorSummary = errors.get(channel.id);
    const usage = byChannel[channel.id] || { requests: 0, errors: 0, rpm: 0, tokenSpeed: 0 };
    const status = !channel.configured
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

const CHANNEL_IDS = new Set(['deepseek']);

function ensureChannel(channel) {
  if (!CHANNEL_IDS.has(channel)) {
    const error = new Error(`Unsupported channel: ${channel}`);
    error.statusCode = 404;
    throw error;
  }
}

/**
 * 渠道公开配置 + 运行时状态注解。
 *
 * 为什么需要合并：配置侧（tokens/accounts）只知道"是否被标记禁用"，不知道
 * 凭据**当前有没有 token**；而"有 token 才能参与调度"是运行时的事实。
 * 不合并的话，一个"已配置但未登录/被封禁"的账号在凭据面板里会显示为可用，
 * 在渠道概览里却计入不可用——同一件事两处数字不同。
 *
 * 注解字段：hasToken / disabled / pending（待登录），与 auth.js 的
 * getCredentialRuntimeStatus 一一对应。
 */
function publicChannelConfigWithRuntime(channel) {
  const config = getPublicChannelConfig(channel);
  if (channel !== 'deepseek') return config;
  const runtime = getCredentialRuntimeStatus();
  const decorate = (list) => (list || []).map(item => {
    const rt = runtime[item.id] || { hasToken: false, disabled: Boolean(item.disabled), pending: !item.disabled };
    return { ...item, ...rt };
  });
  return { ...config, tokens: decorate(config.tokens), accounts: decorate(config.accounts) };
}

function applyChannelRuntime(channel) {
  if (channel === 'deepseek') {
    syncTokenPoolFromConfig();
    stopHealthCheck();
    startHealthCheck();
  }
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
    res.json({ channel, config: publicChannelConfigWithRuntime(channel) });
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
    res.json({ success: true, channel, config: publicChannelConfigWithRuntime(channel) });
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
    res.json({ success: true, channel, config: publicChannelConfigWithRuntime(channel) });
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
    res.json({ success: true, channel, config: publicChannelConfigWithRuntime(channel) });
  } catch (error) {
    jsonError(res, error);
  }
});

// 启用/禁用凭据。禁用不删除配置，仅记录状态：
//   - disabled=true  → 手动禁用（不自动恢复，须人工再启用）
//   - disabled=false → 启用，交回调度
//
// 刻意**不做**同步上游探测：那会让后台请求阻塞在上游延迟（甚至代理超时）上，
// 且启用动作本身不该被探测结果左右。状态由随后的 healthCheck 自然收敛。
// 需要立刻验证请用「测试渠道」按钮。
router.patch('/api/channels/:channel/credentials/:id', (req, res) => {
  try {
    const { channel, id } = req.params;
    ensureChannel(channel);
    const { disabled } = req.body || {};
    if (typeof disabled !== 'boolean') {
      return res.status(400).json({ error: { message: 'disabled (boolean) required' } });
    }

    const target = setCredentialDisabledById(id, disabled);
    if (!target) return res.status(404).json({ error: { message: 'credential not found in runtime pool' } });

    res.json({ success: true, channel, config: publicChannelConfigWithRuntime(channel) });
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

    if (channel === 'deepseek') {
      const { testDeepSeekToken, getDeepSeekPoolEntries, loginAndAddToken, disableAccountByEmail } = await import('../services/auth.js');
      let pool = getDeepSeekPoolEntries();
      // 只给**缺 token 的账号**登录。
      //
      // 旧实现是"只要有任意账号没 token，就给全部账号重登"。而 DeepSeek
      // 每次登录都轮换 token，重登健康账号既无必要（还会作废旧 token 的会话），
      // 又因 loginAndAddToken 的缺陷造成池条目重复（见该函数注释）。
      // 有封禁账号时这个条件恒成立，等于每次点测试都在重复伤害健康账号。
      const tokenlessAccounts = config.deepseek.accounts.filter(account => {
        const entry = pool.find(e => e.email === String(account.email));
        return !entry || !entry.token;
      });
      if (tokenlessAccounts.length > 0) {
        for (const account of tokenlessAccounts) {
          try {
            await loginAndAddToken(String(account.email), String(account.password));
            results.push({ label: account.email, success: true, message: '账号登录成功，Token 已获取' });
          } catch (err) {
            const message = String(err?.message || '');
            // 明确"被封禁"时标记禁用：这类账号不可自愈，若仍显示"等待自动登录"
            // 会误导用户以为迟早会恢复。其它登录失败（WAF 拦截、上游格式变更等）
            // 多为临时性，保持"保留待重试"。
            if (/banned/i.test(message)) {
              disableAccountByEmail(String(account.email), '账号被封禁（登录时上游明确返回）');
              results.push({ label: account.email, success: false, message: '账号已被上游封禁，已标记禁用' });
            } else {
              results.push({ label: account.email, success: false, message: `登录失败: ${message}（账号已保留）` });
            }
          }
        }
        pool = getDeepSeekPoolEntries();
      }
      for (const entry of pool) {
        const label = entry.email || (entry.token ? entry.token.replace(/^(.{6}).*(.{4})$/, '$1...$2') : 'unknown');
        if (entry.disabled && !entry.token) {
          results.push({ label, success: false, message: `已禁用：${entry.disabledReason || '未知原因'}（保留在池中，可手动启用）` });
          continue;
        }
        if (!entry.token) {
          results.push({ label, success: false, message: '无可用 Token（等待自动登录）' });
          continue;
        }
        try {
          const result = await testDeepSeekToken(entry.token);
          if (result.valid) {
            results.push({ label, success: true, message: entry.disabled ? '有效（当前为禁用状态，可手动启用）' : '有效' });
          } else {
            // 关键改动：无效凭据**禁用而非删除**。
            // 旧逻辑调 removeChannelCredential 物理删除配置，导致风控结束后
            // 无从恢复、后台也看不到痕迹。禁用后仍保留在池中并持久化。
            disableTokenByTokenString(entry.token, '手动测试无效');
            results.push({ label, success: false, message: '无效，已禁用（保留在池中，可稍后重试或手动启用）' });
          }
        } catch (err) {
          results.push({ label, success: false, message: err.message });
        }
      }
      // 禁用态已即时写入池并持久化，不重建池（重建会重置在途请求的并发计数）。
      const disabledCount = getPoolInfo().filter(item => item.disabled).length;
      return res.json({
        success: results.some(r => r.success),
        channel,
        results,
        // 原本这里硬编码 true，导致即便没有凭据被禁用，前端也会弹出
        // "失效凭据已禁用"的提示，与实际状态不符。
        disabled: disabledCount > 0,
        disabledCount,
      });
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
    version: appVersion(),
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
    version: appVersion(),
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

// 历史日志 / 完整对话读取端点（/api/logs/dates、/api/logs/history、
// /api/logs/chats）已移除。
//
// 原因：它们会把整天的 jsonl（实测单日 26MB~68MB）全量读入内存，在低配
// 服务器上单个请求即可造成数十 MB 尖峰；且前端从未调用过这三个端点。
// 需要回溯历史请直接读取日志文件：
//   tail -n 200 <logDir>/omni/YYYY-MM-DD.jsonl
//
// 近期日志仍由 /api/logs 提供（读内存环形缓冲，有上限，不碰磁盘）。

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
