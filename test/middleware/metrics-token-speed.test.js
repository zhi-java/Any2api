import test from 'node:test';
import assert from 'node:assert/strict';

import { recordUsage, takePendingUsage, getMetrics, recordRequest } from '../../src/middleware/metrics.js';

// ---------------------------------------------------------------------------
// tok/s 统计
//
// 口径（与 OpenAI 官方一致）：输出 tokens ÷ 整个请求耗时（含首字节等待）。
//
// 为什么不剔除首字节等待：实测上游是"先跑完思考、再瞬发正文"——
// 思考阶段约 1745ms、正文阶段仅约 79ms。若用生成期做分母，分母会小到
// 毫秒级，算出虚高数倍的速度（实测同一次请求：含 TTFB 口径 96.7 tok/s，
// 生成期口径 161.2 tok/s，正文期口径 958.9 tok/s）。
//
// 修复前的问题：recordMetrics 从未被注入到 runner 上下文、
// recordTokenSpeed 从未被调用，导致 tokens 字段恒为 null，
// 后台 tok/s 统计实际是失效的。
// ---------------------------------------------------------------------------

test('recordUsage 在记录存在时直接写入 token 与耗时', () => {
  const model = `m-direct-${Date.now()}`;
  recordRequest(model, 2000, 200);
  recordUsage(model, { outputTokens: 150, durationMs: 2000 });

  const m = getMetrics();
  // tokenSpeed = 150 / (2000/1000) = 75
  assert.equal(m.perModel[model]?.tokenSpeed, 75);
});

test('recordUsage 在记录尚未创建时暂存，随后可取用', () => {
  const model = `m-pending-${Date.now()}`;
  // 先上报（此时 logger 还没写记录）
  recordUsage(model, { outputTokens: 120, durationMs: 1500 });
  const pending = takePendingUsage(model);
  assert.ok(pending, '应暂存待用');
  assert.equal(pending.outputTokens, 120);
  assert.equal(pending.durationMs, 1500);

  // 取用后即清除，避免串到后续请求
  assert.equal(takePendingUsage(model), null);
});

test('recordUsage 忽略无意义的用量（0 tokens 或 0 耗时）', () => {
  const model = `m-zero-${Date.now()}`;
  recordUsage(model, { outputTokens: 0, durationMs: 1000 });
  assert.equal(takePendingUsage(model), null, '0 tokens 不应暂存');
  recordUsage(model, { outputTokens: 100, durationMs: 0 });
  assert.equal(takePendingUsage(model), null, '0 耗时不应用暂存');
});

test('tok/s 口径为「输出 tokens ÷ 总耗时」，不使用生成期', () => {
  const model = `m-formula-${Date.now()}`;
  // 模拟实测场景：总耗时 3000ms（含首字节等待），输出 240 tokens
  recordRequest(model, 3000, 200);
  recordUsage(model, { outputTokens: 240, durationMs: 3000 });

  const speed = getMetrics().perModel[model]?.tokenSpeed;
  assert.equal(speed, 80, '240 tokens / 3s = 80 tok/s');
  // 若误用生成期（如 1.5s）会得到 160，明显虚高
  assert.notEqual(speed, 160);
});
