/**
 * Qwen 渠道统一入口
 */

import { listQwenModels, QWEN_MODEL_MAP } from './models.js';
import { qwenRequestQueue as requestQueue, qwenTokenManager as tokenManager } from './runner.js';

export { QWEN_MODEL_MAP, listQwenModels };

export function getQwenStatus() {
  return {
    pool: tokenManager.getPoolInfo(),
    queue: requestQueue.getQueueInfo(),
  };
}
