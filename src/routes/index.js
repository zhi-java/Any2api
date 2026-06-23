/**
 * 路由聚合器
 *
 * 聚合所有路由模块并挂载到对应路径
 */

import express from 'express';
import apiRoutes from './api.js';
import adminRoutes from './admin.js';
import legacyRoutes from './legacy.js';
import performanceRoutes from './performance.js';

const router = express.Router();

// ============= 挂载路由 =============

// API 路由 (OpenAI/Claude 格式)
router.use('/v1', apiRoutes);

// Admin 面板路由
router.use('/admin', adminRoutes);

// 旧版 API 路由 (DeepSeek 原生格式)
router.use('/api/v0', legacyRoutes);

// 性能监控路由
router.use('/performance', performanceRoutes);

export default router;
