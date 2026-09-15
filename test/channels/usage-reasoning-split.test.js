import test from 'node:test';
import assert from 'node:assert/strict';

// ---------------------------------------------------------------------------
// usage 中 reasoning_tokens 的口径
//
// 实测结论：上游给的 completion_tokens 对应**正文**，不含思考。
//   同一问题，thinking=true → completion_tokens=134（思考 624 字 / 正文 93 字）
//            thinking=false → completion_tokens=102（思考 0 字 / 正文 90 字）
//   正文几乎一致，差值仅 32；若 completion_tokens 含思考，差值应与思考量
//   （数百 token）同阶。
//
// 因此不能把它当「含思考的总量」再按比例拆分，否则正文 token 会趋近 0，
// 客户端用「正文 token ÷ 正文跨度」计算时，分母是上游瞬发正文的极短时窗
// （实测 208ms 出 53 个分片），会得出 3589 这类夸张的 tok/s。
//
// 正确做法：completion_tokens 作为正文 token，思考 token 按字符量单独估算，
// 两者相加作为总输出量。
// ---------------------------------------------------------------------------

/** 复刻 runner 中的拆分逻辑，便于单测固化口径。 */
function splitUsage({ upstreamOutputTokens, visibleChars, reasoningChars }) {
  const visibleTokens = upstreamOutputTokens || Math.round(visibleChars / 4);
  const estimatedReasoningTokens = Math.round(reasoningChars / 4);
  return { visibleTokens, estimatedReasoningTokens, outputTokensFinal: visibleTokens + estimatedReasoningTokens };
}

test('completion_tokens 视为正文，思考量另行累加', () => {
  const r = splitUsage({ upstreamOutputTokens: 134, visibleChars: 93, reasoningChars: 624 });
  assert.equal(r.visibleTokens, 134, '正文沿用上游值');
  assert.equal(r.estimatedReasoningTokens, 156, '思考按 624/4 估算');
  assert.equal(r.outputTokensFinal, 290, '总量 = 正文 + 思考');
  // 关键：正文 token 不得因思考而趋近 0
  assert.ok(r.visibleTokens > 0, '正文 token 必须为正，否则客户端会算出天文数字');
});

test('纯正文回答（无思考）时 reasoning_tokens 为 0', () => {
  const r = splitUsage({ upstreamOutputTokens: 102, visibleChars: 90, reasoningChars: 0 });
  assert.equal(r.estimatedReasoningTokens, 0);
  assert.equal(r.outputTokensFinal, 102);
});

test('无上游用量时按字符估算正文与思考', () => {
  const r = splitUsage({ upstreamOutputTokens: 0, visibleChars: 200, reasoningChars: 400 });
  assert.equal(r.visibleTokens, 50, '200/4');
  assert.equal(r.estimatedReasoningTokens, 100, '400/4');
  assert.equal(r.outputTokensFinal, 150);
});

test('正文 token 不会被思考量吃掉（防止客户端算出夸张 tok/s）', () => {
  // 极端场景：思考极长、正文很短（实测 3589 tok/s 的成因）
  const r = splitUsage({ upstreamOutputTokens: 5, visibleChars: 10, reasoningChars: 5000 });
  assert.equal(r.visibleTokens, 5, '正文仍保留上游给出的真实值');
  assert.ok(r.visibleTokens > 0);
  // 若旧实现（min(思考/4, completion_tokens)）会得到 reasoning=5、正文=0
  assert.notEqual(r.outputTokensFinal - r.estimatedReasoningTokens, 0, '正文不得为 0');
});
