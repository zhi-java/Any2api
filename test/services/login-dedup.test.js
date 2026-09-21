import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// ---------------------------------------------------------------------------
// 账号重复登录不得产生重复池条目
//
// 背景（实测复现）：DeepSeek **每次登录都轮换 token**。旧版 loginAndAddToken
// 先按「email 匹配且无 token」查找，再按「新 token」查找——对已有 token 的
// 账号再登录时两次都落空，于是 push 出重复条目。
//
// 放大条件：后台「测试渠道」原先的门槛是"只要有任意账号没 token 就给**全部**
// 账号重登"。当池中存在被封禁（永远拿不到 token）的账号时该条件恒成立，
// 于是每点一次测试，健康账号就被复制一份。实测线上 10 个账号涨到 15 条，
// 渠道概览显示 "10/15 可用"、凭据面板显示 "10 可用"，两处数字对不上。
//
// 修复后：loginAndAddToken 只按 email 定位条目（账号是稳定身份，token 是
// 可变属性），且测试接口只给缺 token 的账号登录。
// ---------------------------------------------------------------------------

async function setupEnv(accounts = 'a@x.com:pw, b@x.com:pw') {
  const dir = mkdtempSync(join(tmpdir(), 'omni-login-dedup-'));
  process.env.ZHI2API_CONFIG_PATH = join(dir, 'cfg.json');
  const emptyEnv = join(dir, 'e.env');
  writeFileSync(emptyEnv, '');
  process.env.ZHI2API_ENV_PATH = emptyEnv;
  delete process.env.DS_TOKENS;
  delete process.env.DS_ACCOUNTS_EXTENDED;
  process.env.DS_ACCOUNTS = accounts;

  const configStore = await import('../../src/services/config-store.js');
  configStore.loadConfig({ force: true });
  return dir;
}

/**
 * 桩掉上游：login 每次返回**不同的** token，模拟真实的上游轮换行为。
 * 这正是能暴露重复 bug 的关键——若每次返回相同 token，旧代码也不会重复。
 */
function stubRotatingLogin() {
  const original = globalThis.fetch;
  let seq = 0;
  globalThis.fetch = async (url) => {
    const text = String(url);
    if (text.includes('/users/login')) {
      seq += 1;
      return new Response(JSON.stringify({
        code: 0,
        data: { biz_data: { user: { token: `TOKEN-${seq}-${'x'.repeat(50)}` } } },
      }), { status: 200 });
    }
    if (text.includes('/client/settings')) {
      return new Response(JSON.stringify({ code: 0, data: { biz_data: { settings: { model_configs: { value: [] } } } } }), { status: 200 });
    }
    return new Response(JSON.stringify({ code: 0 }), { status: 200 });
  };
  return () => { globalThis.fetch = original; };
}

test('同一账号重复登录不产生重复池条目（token 每次轮换也如此）', async () => {
  const dir = await setupEnv();
  const restore = stubRotatingLogin();
  try {
    const auth = await import('../../src/services/auth.js');
    auth.syncTokenPoolFromConfig();
    assert.equal(auth.getPoolInfo().length, 2, '初始应有 2 个账号条目');

    const accounts = [{ email: 'a@x.com', password: 'pw' }, { email: 'b@x.com', password: 'pw' }];

    await auth.loginAndAddToken(accounts[0].email, accounts[0].password);
    await auth.loginAndAddToken(accounts[1].email, accounts[1].password);
    assert.equal(auth.getPoolInfo().length, 2, '首次登录后仍是 2 条');

    // 关键：再次登录（模拟再点一次「测试渠道」）。上游会返回新 token。
    const t3 = await auth.loginAndAddToken(accounts[0].email, accounts[0].password);
    const t4 = await auth.loginAndAddToken(accounts[1].email, accounts[1].password);
    assert.equal(auth.getPoolInfo().length, 2, '重复登录后不应新增条目');

    // 新 token 应替换旧 token（而非并存）
    const pool = auth.getPoolInfo();
    assert.equal(pool.length, 2);
    assert.equal(pool.filter(e => e.email === 'a@x.com').length, 1, '同账号只应有一个条目');
    assert.equal(pool.filter(e => e.email === 'b@x.com').length, 1, '同账号只应有一个条目');
    assert.ok(t3 !== t4, '两个账号拿到的 token 应不同');
  } finally {
    restore();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('同一账号只占一个池位：多个账号重复登录后总数恒等于账号数', async () => {
  const dir = await setupEnv('a@x.com:pw, b@x.com:pw, c@x.com:pw');
  const restore = stubRotatingLogin();
  try {
    const auth = await import('../../src/services/auth.js');
    auth.syncTokenPoolFromConfig();

    for (let round = 0; round < 3; round++) {
      for (const email of ['a@x.com', 'b@x.com', 'c@x.com']) {
        await auth.loginAndAddToken(email, 'pw');
      }
      assert.equal(auth.getPoolInfo().length, 3, `第 ${round + 1} 轮后仍应是 3 条`);
    }

    const emails = auth.getPoolInfo().map(e => e.email).filter(Boolean);
    assert.equal(new Set(emails).size, emails.length, '不应出现重复邮箱');
  } finally {
    restore();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('运行时状态注解可与配置侧对齐（供概览与凭据面板统一口径）', async () => {
  const dir = await setupEnv('a@x.com:pw, b@x.com:pw');
  const restore = stubRotatingLogin();
  try {
    const auth = await import('../../src/services/auth.js');
    const configStore = await import('../../src/services/config-store.js');
    auth.syncTokenPoolFromConfig();

    // 只给 a 登录，b 保持无 token
    await auth.loginAndAddToken('a@x.com', 'pw');

    const runtime = auth.getCredentialRuntimeStatus();
    const accounts = configStore.getPublicConfig().deepseek.accounts;
    assert.equal(accounts.length, 2);

    const statusOf = (email) => {
      const item = accounts.find(a => a.email === email);
      return runtime[item.id];
    };
    assert.equal(statusOf('a@x.com').hasToken, true, 'a 应已持有 token');
    assert.equal(statusOf('a@x.com').pending, false);
    assert.equal(statusOf('b@x.com').hasToken, false, 'b 尚未登录');
    assert.equal(statusOf('b@x.com').pending, true, 'b 应为待登录');

    // 依据该注解统计的三态之和 == 配置的凭据总数（这正是两处数字对不上的根源）
    const rows = Object.values(runtime);
    const available = rows.filter(r => r.hasToken && !r.disabled).length;
    const pending = rows.filter(r => r.pending).length;
    const disabled = rows.filter(r => r.disabled).length;
    assert.equal(available + pending + disabled, 2, '三态之和应等于凭据总数');
    assert.equal(available, 1);
    assert.equal(pending, 1);
  } finally {
    restore();
    rmSync(dir, { recursive: true, force: true });
  }
});
