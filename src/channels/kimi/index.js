/**
 * Kimi 渠道统一入口
 */

import { KimiTokenManager } from './auth.js';
import { handleKimiClaude, handleKimiOpenAI } from './handlers.js';
import { KIMI_MODEL_MAP, listKimiModels } from './models.js';

const tokenManager = new KimiTokenManager();

export { KIMI_MODEL_MAP, listKimiModels };

export async function handleKimiCompletion(req, res) {
  return handleKimiOpenAI(req, res, tokenManager);
}

export async function handleKimiClaudeMessages(req, res) {
  return handleKimiClaude(req, res, tokenManager);
}

export function getKimiStatus() {
  return {
    pool: tokenManager.getPoolInfo(),
  };
}
