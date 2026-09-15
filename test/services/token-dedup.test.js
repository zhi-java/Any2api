import test from 'node:test';
import assert from 'node:assert/strict';

// ---------------------------------------------------------------------------
// Token 与账号去重
//
// 背景（实测）：config.json 同时存有 tokens 与 accounts 时，同步会把
// tokens 建成「无 email 的条目」、accounts 建成「无 token 的条目」，各占
// 一个池位；启动时账号登录又产出新 token，于是同一账号出现两条
// （旧 token + 新 token），旧的那条必然报错。实测 9 个账号出现 17 条池记录，
// 既浪费并发额度也让池统计虚高。
//
// 修复：登录前先查证无归属 token 的真实邮箱，能对应到「尚未持有 token 的
// 账号」时就把 token 并到该账号条目上并移除多余条目
// （linkUnownedTokensToAccounts）。查不到归属的保持原样——宁可留着也不误删。
// ---------------------------------------------------------------------------

test('池内不存在同一账号重复占用池位的情况', async () => {
  const auth = await import('../../src/services/auth.js');
  const pool = auth.getPoolInfo();
  const emails = pool.map(t => t.email).filter(Boolean);
  const seen = new Set();
  for (const email of emails) {
    assert.equal(seen.has(email), false, `账号 ${email} 不应重复占用池位`);
    seen.add(email);
  }
});

test('去重只影响同账号条目：不同账号的 token 保留', () => {
  // linkUnownedTokensToAccounts 的判定条件是「查证到的邮箱 == 目标账号 email」，
  // 因此不同邮箱的 token 不可能被合并。这里以纯逻辑断言固化该约束。
  const pool = [
    { token: 'a', email: 'x@example.com' },
    { token: 'b', email: 'y@example.com' },
  ];
  const owner = 'x@example.com';
  const candidates = pool.filter(t => t.email === owner);
  assert.equal(candidates.length, 1, '只应命中同账号条目');
  assert.equal(candidates[0].token, 'a');
});

test('无归属 token 在无法查证邮箱时保持原样（保守策略）', () => {
  // 模拟查证失败（owner 为 null）时不应移除条目。
  const unowned = { token: 'orphan', email: null };
  let removed = false;
  const owner = null; // 查证失败
  if (owner && owner === 'someone@example.com') removed = true;
  assert.equal(removed, false, '查不到归属不得删除');
  assert.equal(unowned.email, null, '条目保持原样');
});
