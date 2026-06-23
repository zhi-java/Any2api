/**
 * Performance 路由
 *
 * 处理性能监控端点
 * - GET /performance (性能监控面板)
 * - GET /performance/api/metrics (指标数据)
 * - GET /performance/api/timeseries (时间序列数据)
 */

import express from 'express';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { getMetrics, getTimeseries } from '../middleware/metrics.js';
import { getPoolInfo, getTotalCapacity } from '../services/auth.js';
import { getQueueInfo } from '../services/queue.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const router = express.Router();

// ============= Performance 面板 UI =============

router.get('/', (req, res) => {
  res.sendFile(join(__dirname, '..', 'performance', 'index.html'));
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
