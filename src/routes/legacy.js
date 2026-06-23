/**
 * Legacy API 路由
 *
 * 处理旧版 API 端点（向后兼容）
 * - POST /api/v0/chat/completion (DeepSeek 原生格式)
 */

import express from 'express';
import deepseek from '../channels/deepseek/index.js';

const router = express.Router();

// ============= DeepSeek 原生格式（旧版 API） =============
router.post('/chat/completion', deepseek.handleNative);

export default router;
