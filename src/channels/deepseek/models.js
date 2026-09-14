/**
 * DeepSeek 模型配置
 *
 * 上游已于 2026-09 合并模型能力，不再区分 flash/pro 两档：
 *   - /api/v0/client/settings 中 normal_* 与 r1_* 的 token 上限已收敛为同一值
 *   - 请求体的 model_type 仅保留单一取值 'default'
 * 因此对外只暴露一个模型 ID。
 */

import { normalizeRequestedModelName } from '../../utils/response-utils.js';

/** 对外公开的唯一模型 ID。 */
export const DEEPSEEK_MODEL = 'deepseek-flash';

/** 上游 model_type 取值（合并后仅此一种）。 */
export const DEEPSEEK_MODEL_TYPE = 'default';

export const DEEPSEEK_MODEL_MAP = {
  [DEEPSEEK_MODEL]: DEEPSEEK_MODEL_TYPE,
};

/**
 * 映射请求模型名到上游 model_type。
 * 仅接受公开模型表中的名称；归一化只剥离客户端附加的 [1m] 等后缀。
 */
export function mapModel(model) {
  const normalized = normalizeRequestedModelName(model);
  if (!normalized) throw new Error(`Invalid model: ${model}`);

  const mapped = DEEPSEEK_MODEL_MAP[normalized];
  if (mapped) return mapped;

  throw new Error(
    `Unknown model: ${model}. Available: ${Object.keys(DEEPSEEK_MODEL_MAP).join(', ')}`
  );
}
