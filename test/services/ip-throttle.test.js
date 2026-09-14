import test from 'node:test';
import assert from 'node:assert/strict';

import {
  noteEmptyReply,
  noteSuccessfulReply,
  isIpThrottled,
  getIpThrottleRemainingMs,
  resetIpThrottleState,
} from '../../src/services/auth.js';

// ---------------------------------------------------------------------------
// IP 级限流（实测 2026-09-14）：
//   连续长内容生成累计约 1.8MB 后，上游对「整个出口 IP」限流，
//   表现为 HTTP 200 + 281 字节空流（仅 role 与 finish_reason）。
//   对照实验证明与账号/凭据/会话均无关——3 个不同账号的凭据
//   同时被限制，等待 14 分钟仍未恢复。
//   因此凭据轮换无法规避，只能识别后退避，并向客户端明确报错。
//
//   判据刻意只数「连续空流次数」，不要求「不同凭据」：单一凭据场景
//   同样会遭遇 IP 限流，若强制要求不同凭据则永远无法识别。
// ---------------------------------------------------------------------------

test('连续空回复达到阈值后判定为 IP 级限流', () => {
  resetIpThrottleState();
  assert.equal(isIpThrottled(), false);

  // 单次/两次空流不足以判定（偶发空流可由续写恢复）
  noteEmptyReply();
  assert.equal(isIpThrottled(), false, '单次空流不应判定');
  noteEmptyReply();
  assert.equal(isIpThrottled(), false, '两次空流仍不应判定');

  // 连续第三次 ⇒ 并非偶发，判定为 IP 级限制
  noteEmptyReply();
  assert.equal(isIpThrottled(), true, '连续三次空流应判定为 IP 限流');
  assert.ok(getIpThrottleRemainingMs() > 0, '应产生冷却窗口');
});

test('单一凭据场景同样能识别 IP 限流（不要求不同凭据）', () => {
  resetIpThrottleState();
  // 池中只有一个凭据时，连续空流也应被识别——否则限流永远无法发现
  for (let i = 0; i < 3; i++) noteEmptyReply();
  assert.equal(isIpThrottled(), true, '单凭据连续空流也要能识别');
});

test('成功响应清除 IP 限流状态与空流计数', () => {
  resetIpThrottleState();
  noteEmptyReply();
  noteEmptyReply();
  noteEmptyReply();
  assert.equal(isIpThrottled(), true);

  noteSuccessfulReply();
  assert.equal(isIpThrottled(), false, '成功应清除 IP 限流状态');
  assert.equal(getIpThrottleRemainingMs(), 0);

  // 清除后需重新累积到阈值才再次判定
  noteEmptyReply();
  noteEmptyReply();
  assert.equal(isIpThrottled(), false, '成功后空流计数应已清零');
});

test('IP 限流冷却期内持续判定为受限，且冷却时长随时间递减', async () => {
  resetIpThrottleState();
  noteEmptyReply();
  noteEmptyReply();
  noteEmptyReply();
  const first = getIpThrottleRemainingMs();
  assert.ok(first > 0);
  await new Promise(r => setTimeout(r, 60));
  const second = getIpThrottleRemainingMs();
  assert.ok(second < first, `冷却剩余应递减 (${second} < ${first})`);
  assert.equal(isIpThrottled(), true);
});
