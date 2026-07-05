/**
 * Kimi 渠道统一入口
 */

import { KIMI_MODEL_MAP, listKimiModels } from './models.js';
import { kimiTokenManager as tokenManager } from './runner.js';

export { KIMI_MODEL_MAP, listKimiModels };

export function getKimiStatus() {
  return {
    pool: tokenManager.getPoolInfo(),
  };
}
