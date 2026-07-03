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
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { getPoolInfo, getTotalCapacity, addTokenToPool, loginAndAddToken } from '../services/auth.js';
import { getSessionInfo } from '../services/session.js';
import { getConversationInfo } from '../services/conversation.js';
import { getQueueInfo } from '../services/queue.js';
import { getRecentLogs, getLogStats, readHistoricalLogs, readChatLogs, listLogDates } from '../middleware/logger.js';
import { getMetrics, getTimeseries } from '../middleware/metrics.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const router = express.Router();

// 用于计算 uptime
const startTime = Date.now();

// ============= 静态资源服务 =============

// 静态资源（CSS, JS, 页面等）
router.use('/styles', express.static(join(__dirname, '..', 'admin', 'styles')));
router.use('/scripts', express.static(join(__dirname, '..', 'admin', 'scripts')));
router.use('/pages', express.static(join(__dirname, '..', 'admin', 'pages')));
router.use('/assets', express.static(join(__dirname, '..', 'admin', 'assets')));

// ============= Admin 面板 UI =============

router.get('/', (req, res) => {
  res.sendFile(join(__dirname, '..', 'admin', 'index.html'));
});

router.get('/chat', (req, res) => {
  res.sendFile(join(__dirname, '..', 'admin', 'chat.html'));
});

router.get('/legacy', (req, res) => {
  res.sendFile(join(__dirname, '..', 'admin', 'legacy.html'));
});

router.get('/chat-legacy', (req, res) => {
  res.sendFile(join(__dirname, '..', 'admin', 'chat-legacy.html'));
});

// ============= 统计信息 API =============

router.get('/api/stats', (req, res) => {
  const uptimeSeconds = Math.floor((Date.now() - startTime) / 1000);
  res.json({
    status: 'ok',
    version: '1.0.0',
    uptimeSeconds,
    pool: getPoolInfo(),
    totalCapacity: getTotalCapacity(),
    queue: getQueueInfo(),
    sessions: getSessionInfo(),
    conversations: getConversationInfo(),
    logStats: getLogStats(),
  });
});

// ============= 日志查询 API =============

router.get('/api/logs', (req, res) => {
  const count = Math.min(parseInt(req.query.count) || 50, 200);
  res.json({ logs: getRecentLogs(count), stats: getLogStats() });
});

router.get('/api/logs/dates', (req, res) => {
  res.json({ dates: listLogDates() });
});

router.get('/api/logs/history', (req, res) => {
  const { date } = req.query;
  if (!date) return res.status(400).json({ error: { message: 'date param required (YYYY-MM-DD)' } });
  const count = Math.min(parseInt(req.query.count) || 100, 10000);
  res.json({ logs: readHistoricalLogs(date, count) });
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
    res.json({ success: true, visionCapable: added.visionCapable });
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

export default router;
