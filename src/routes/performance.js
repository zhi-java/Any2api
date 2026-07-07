/**
 * Performance 路由
 *
 * 处理性能监控端点
 * - GET /performance (性能监控面板)
 * - GET /performance/api/metrics (指标数据)
 * - GET /performance/api/timeseries (时间序列数据)
 */

import express from 'express';
import { getMetrics, getTimeseries } from '../middleware/metrics.js';
import { getPoolInfo, getTotalCapacity } from '../services/auth.js';
import { getQueueInfo } from '../services/queue.js';

const router = express.Router();

// ============= Performance 面板 UI =============

router.get('/', (_req, res) => {
  res.redirect(302, '/admin#performance');
});

// ============= Performance API =============

router.get('/api/metrics', (req, res) => {
  res.json(getMetrics());
});

router.get('/api/timeseries', (req, res) => {
  const range = req.query.range || '6h';
  const points = getTimeseries(range);
  const pool = getPoolInfo();
  const totalCap = getTotalCapacity();
  const queue = getQueueInfo();
  res.json({ points, pool, totalCapacity: totalCap, queue });
});

export default router;
