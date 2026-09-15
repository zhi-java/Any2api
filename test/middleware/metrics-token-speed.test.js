import test from 'node:test';
import assert from 'node:assert/strict';

import { recordUsage, takeUsage, recordUsageRecord, recordRequest, getMetrics } from '../../src/middleware/metrics.js';

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
// 配对方式：runner 把用量挂在 res 上，日志中间件取出后写入「本次请求刚
// 创建的那条记录」。早期的"按模型配对最近一条未配对记录"在并发下会错配
// （把 A 的 token 数配到 B 的耗时上），实测算出过 1586、780 这类畸形值。
// ---------------------------------------------------------------------------

test('usage 挂在 res 上并且只被消费一次', () => {
  const res = {};
  recordUsage(res, { outputTokens: 150, durationMs: 2000 });
  assert.deepEqual(takeUsage(res), { outputTokens: 150, durationMs: 2000 });
  assert.equal(takeUsage(res), null, '重复取用应返回 null');
});

test('recordUsage 忽略无意义的用量', () => {
  const res = {};
  recordUsage(res, { outputTokens: 0, durationMs: 2000 });
  assert.equal(takeUsage(res), null, '0 tokens 不应写入');
  recordUsage(res, { outputTokens: 100, durationMs: 0 });
  assert.equal(takeUsage(res), null, '0 耗时不应用写入');
  recordUsage(null, { outputTokens: 100, durationMs: 1000 });
  assert.equal(takeUsage(null), null, 'res 缺失时安全返回');
});

test('用量写入本次请求刚创建的记录，tok/s 口径为「tokens ÷ 总耗时」', () => {
  const model = `m-basic-${Date.now()}`;
  const record = recordRequest(model, 3000, 200);
  recordUsageRecord(record, { outputTokens: 240, durationMs: 3000 });

  const speed = getMetrics().perModel[model]?.tokenSpeed;
  assert.equal(speed, 80, '240 tokens / 3s = 80 tok/s');
  // 若误用生成期（如 1.5s）会得到 160，明显虚高
  assert.notEqual(speed, 160);
});

test('并发请求互不干扰（各自写入自己的记录）', () => {
  const model = `m-concurrent-${Date.now()}`;

  // 两个请求交错：各自创建记录、各自写入用量
  const recA = recordRequest(model, 2000, 200);
  const recB = recordRequest(model, 1000, 200);
  recordUsageRecord(recB, { outputTokens: 100, durationMs: 1000 });  // B: 100/1s = 100
  recordUsageRecord(recA, { outputTokens: 150, durationMs: 2000 });  // A: 150/2s = 75

  const perModel = getMetrics().perModel[model];
  // 两次记录各自独立：平均 (100 + 75) / 2 = 87.5 → 88
  assert.equal(perModel.requests, 2);
  assert.equal(perModel.tokenSpeed, 88, '并发下各自独立配对，不串号');

  // 关键：不得出现因错配而产生的畸形值（如把 150 tokens 配到 1s 得到 150）
  assert.ok(perModel.tokenSpeed < 120, `不应出现虚高值（实际 ${perModel.tokenSpeed}）`);
});
