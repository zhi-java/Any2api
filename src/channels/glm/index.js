/**
 * GLM 渠道统一入口
 */

import { GLM_MODEL_MAP } from './models.js';
import { glmTokenManager as tokenManager } from './runner.js';

export { GLM_MODEL_MAP };

export function getGLMStatus() {
  return {
    auth: tokenManager.getPoolInfo(),
  };
}
