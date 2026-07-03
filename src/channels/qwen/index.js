/**
 * Qwen 渠道统一入口
 */

import { QwenTokenManager } from './auth.js';
import { QwenRequestQueue } from './queue.js';
import { handleQwenClaude, handleQwenOpenAI } from './handlers.js';
import { listQwenModels, QWEN_MODEL_MAP } from './models.js';

const tokenManager = new QwenTokenManager();
const requestQueue = new QwenRequestQueue(tokenManager);

export { QWEN_MODEL_MAP, listQwenModels };

export async function handleQwenCompletion(req, res) {
  return handleQwenOpenAI(req, res, tokenManager, requestQueue);
}

export async function handleQwenClaudeMessages(req, res) {
  return handleQwenClaude(req, res, tokenManager, requestQueue);
}

export function handleQwenModels(req, res) {
  res.json({ object: 'list', data: listQwenModels() });
}

export function getQwenStatus() {
  return {
    pool: tokenManager.getPoolInfo(),
    queue: requestQueue.getQueueInfo(),
  };
}
