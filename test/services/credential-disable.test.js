import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// ---------------------------------------------------------------------------
// 凭据「禁用」态（替代原先的删除）
//
// 背景：上游风控（禁言 3 天/封禁）后，旧实现把这些凭据**物理删除**，导致
//   ① 风控结束无法恢复（没有任何"恢复"机制）；
//   ② 后台完全看不到（getPoolInfo 过滤掉 dead 条目）；
//   ③ 重启后彻底消失（persist 时丢弃 dead 条目）。
//
// 现在统一为第三态「禁用」：退出调度但保留在池中、写入 config.json 的
// credentialStates、后台可见、到期自动探测恢复、也可人工启用/禁用。
// 临时限流（429）仍走 cooldownUntil，语义不变。
//
// 注意：所有上游探测（/users/current、/users/login、/client/settings）都用
// fetch 桩拦掉，避免测试依赖真实网络。
// ---------------------------------------------------------------------------

/**
 * 准备隔离环境。
 *
 * 必须强制 loadConfig({force:true})：config-store 的 configPath 是模块级
 * 缓存，第一次解析后就固定了；不强制重载会让后续测试继续写上一个（已删除的）
 * 临时目录，导致"禁用态没写进配置"这类假失败。
 */
async function setupEnv({ tokens = 'token-AAA, token-BBB, token-CCC', accounts = '' } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'omni-cred-disable-'));
  process.env.ZHI2API_CONFIG_PATH = join(dir, 'config.json');
  const emptyEnv = join(dir, 'empty.env');
  writeFileSync(emptyEnv, '');
  process.env.ZHI2API_ENV_PATH = emptyEnv;
  delete process.env.DS_TOKEN;
  delete process.env.DS_ACCOUNTS_EXTENDED;
  process.env.DS_TOKENS = tokens;
  if (accounts) process.env.DS_ACCOUNTS = accounts;
  else delete process.env.DS_ACCOUNTS;

  const configStore = await import('../../src/services/config-store.js');
  configStore.loadConfig({ force: true });
  return dir;
}

function readConfig() {
  const path = process.env.ZHI2API_CONFIG_PATH;
  return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : null;
}

/**
 * 安装 fetch 桩：按 URL 返回可控响应。
 * valid=false 时 /users/current 返回 40003（模拟 token 失效/仍在风控）。
 */
function stubFetch({ valid = false, onLogin = null } = {}) {
  const original = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const text = String(url);
    if (text.includes('/users/current')) {
      return new Response(JSON.stringify(valid
        ? { code: 0, data: { biz_code: 0, biz_data: { email: 'stub@example.com' } } }
        : { code: 40003, msg: 'Authorization Failed (invalid token)' }), { status: 200 });
    }
    if (text.includes('/users/login')) {
      if (onLogin) onLogin();
      return new Response(JSON.stringify({ code: 0, data: { biz_data: { user: { token: 'stub-fresh-token' } } } }), { status: 200 });
    }
    if (text.includes('/client/settings')) {
      return new Response(JSON.stringify({ code: 0, data: { biz_data: { settings: { model_configs: { value: [] } } } } }), { status: 200 });
    }
    return new Response(JSON.stringify({ code: 0 }), { status: 200 });
  };
  return () => { globalThis.fetch = original; };
}

function tokenOf(slot) { return slot.token; }

test('禁用后凭据仍可见（getPoolInfo 不过滤禁用条目）', async () => {
  const dir = await setupEnv();
  try {
    const auth = await import('../../src/services/auth.js');
    auth.syncTokenPoolFromConfig();

    const slot = auth.acquireToken();
    const token = tokenOf(slot);
    slot.release();

    // 旧实现下这条会直接从池里消失，后台什么都看不到。
    auth.disableToken(token, { reason: '账号被封禁 (40004)', disabledUntil: Date.now() + 86_400_000 });

    const entry = auth.getPoolInfo().find(t => token.startsWith(t.token.replace('...', '')));
    assert.ok(entry, '禁用后凭据仍应出现在池信息中');
    assert.equal(entry.disabled, true, '应标记为禁用');
    assert.match(entry.disabledReason, /封禁/);
    assert.ok(entry.disabledRemainingMs > 0, '应给出自动恢复剩余时间');

    const entries = auth.getDeepSeekPoolEntries();
    assert.equal(entries.some(e => e.disabled), true, 'getDeepSeekPoolEntries 也应包含禁用条目');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('禁用凭据不再参与分配，也不计入容量', async () => {
  const dir = await setupEnv();
  try {
    const auth = await import('../../src/services/auth.js');
    auth.syncTokenPoolFromConfig();

    const total = auth.getTotalCapacity();
    const slot = auth.acquireToken();
    const token = tokenOf(slot);
    slot.release();

    auth.disableToken(token, { reason: '测试禁用', disabledUntil: Date.now() + 86_400_000 });

    assert.ok(auth.getTotalCapacity() < total, '禁用后总容量应下降');
    assert.equal(auth.getAliveTokens().includes(token), false, '禁用凭据不应出现在可用列表中');

    for (let i = 0; i < 20; i++) {
      const next = auth.acquireToken();
      if (!next) break;
      assert.notEqual(next.token, token, '禁用凭据不应被再次分配');
      next.release();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('禁用态写入 config.json，且从磁盘重载后仍保留（持久化）', async () => {
  const dir = await setupEnv();
  try {
    const auth = await import('../../src/services/auth.js');
    const configStore = await import('../../src/services/config-store.js');
    auth.syncTokenPoolFromConfig();

    const slot = auth.acquireToken();
    const token = tokenOf(slot);
    slot.release();

    auth.disableToken(token, { reason: '账号被禁言', disabledUntil: Date.now() + 2_592_000_000 });

    const config = readConfig();
    const stateIds = Object.keys(config?.deepseek?.credentialStates || {});
    assert.equal(stateIds.length, 1, '禁用态应被持久化到 credentialStates');
    const state = config.deepseek.credentialStates[stateIds[0]];
    assert.equal(state.disabled, true);
    assert.match(state.reason, /禁言/);
    assert.equal(state.source, 'auto');

    // 凭据本体必须保留在 tokens 里，否则重启后禁用记录会被当成 stale key 剪掉。
    assert.equal(config.deepseek.tokens.includes(token), true, '禁用中的 token 仍应写回配置');

    // 模拟重启：强制从磁盘重读配置，再同步进池。
    configStore.loadConfig({ force: true });
    auth.syncTokenPoolFromConfig();
    const restored = auth.getPoolInfo().find(t => token.startsWith(t.token.replace('...', '')));
    assert.ok(restored, '重启同步后凭据应仍在池中');
    assert.equal(restored.disabled, true, '重启同步后禁用态应保留');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('自动禁用：禁期到期且探测成功后恢复', async () => {
  const dir = await setupEnv({ tokens: 'token-AAA' });
  try {
    const auth = await import('../../src/services/auth.js');
    auth.syncTokenPoolFromConfig();

    const slot = auth.acquireToken();
    const token = tokenOf(slot);
    slot.release();

    // 禁期设为已过去，模拟"风控结束"。
    auth.disableToken(token, { reason: '临时封禁', disabledUntil: Date.now() - 1000, source: 'auto' });
    assert.equal(auth.getPoolInfo().find(t => t.disabled)?.disabled, true);

    const restore = stubFetch({ valid: true });
    try {
      await auth.healthCheck();
    } finally {
      restore();
    }

    const after = auth.getPoolInfo().find(t => token.startsWith(t.token.replace('...', '')));
    assert.equal(after.disabled, false, '探测成功后应自动恢复');
    assert.equal(auth.getAliveTokens().includes(token), true, '恢复后应回到可用列表');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('自动禁用：禁期到期但探测失败时禁期顺延（不每周期打上游）', async () => {
  const dir = await setupEnv({ tokens: 'token-AAA' });
  try {
    const auth = await import('../../src/services/auth.js');
    auth.syncTokenPoolFromConfig();

    const slot = auth.acquireToken();
    const token = tokenOf(slot);
    slot.release();

    auth.disableToken(token, { reason: '仍在风控', disabledUntil: Date.now() - 1000, source: 'auto' });
    assert.equal(auth.getPoolInfo().find(t => t.disabled)?.disabledRemainingMs, 0);

    const restore = stubFetch({ valid: false });
    try {
      await auth.healthCheck();
    } finally {
      restore();
    }

    const after = auth.getPoolInfo().find(t => token.startsWith(t.token.replace('...', '')));
    assert.equal(after.disabled, true, '探测失败应保持禁用');
    assert.ok(after.disabledRemainingMs > 0, '禁期应被顺延');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('手动禁用不被到期探测或一次成功悄悄解除', async () => {
  const dir = await setupEnv({ tokens: 'token-AAA' });
  try {
    const auth = await import('../../src/services/auth.js');
    auth.syncTokenPoolFromConfig();

    const slot = auth.acquireToken();
    const token = tokenOf(slot);
    slot.release();

    // 手动禁用：until=0，表示不自动恢复。
    auth.disableToken(token, { reason: '管理员手动禁用', disabledUntil: 0, source: 'manual' });
    const entry = auth.getPoolInfo().find(t => t.disabled);
    assert.equal(entry.disabledSource, 'manual');
    assert.equal(entry.disabledRemainingMs, 0, '手动禁用不应有自动恢复计划');

    const restore = stubFetch({ valid: true });
    try {
      await auth.healthCheck();
    } finally {
      restore();
    }
    assert.equal(auth.getPoolInfo().find(t => token.startsWith(t.token.replace('...', ''))).disabled, true,
      '健康检查不应解除手动禁用');

    // 即便有一次成功上报，也不能解除（防人工下线的凭据自行回到调度）。
    auth.reportTokenSuccess(token);
    assert.equal(auth.getPoolInfo().find(t => token.startsWith(t.token.replace('...', ''))).disabled, true,
      '成功上报不应解除手动禁用');

    auth.enableToken(token);
    assert.equal(auth.getPoolInfo().find(t => token.startsWith(t.token.replace('...', ''))).disabled, false,
      '显式启用后应恢复');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('自动禁用可被一次成功恢复（与手动禁用区分）', async () => {
  const dir = await setupEnv({ tokens: 'token-AAA' });
  try {
    const auth = await import('../../src/services/auth.js');
    auth.syncTokenPoolFromConfig();

    const slot = auth.acquireToken();
    const token = tokenOf(slot);
    slot.release();

    auth.disableToken(token, { reason: '连续错误达阈值', disabledUntil: Date.now() + 86_400_000, source: 'auto' });
    assert.equal(auth.getPoolInfo().find(t => t.disabled).disabled, true);

    auth.reportTokenSuccess(token);
    assert.equal(auth.getPoolInfo().find(t => token.startsWith(t.token.replace('...', ''))).disabled, false,
      '自动禁用应可被成功恢复');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('按 id 启用/禁用（admin 路径）；删除凭据会清掉禁用记录', async () => {
  const dir = await setupEnv({ tokens: 'token-AAA, token-BBB' });
  try {
    const auth = await import('../../src/services/auth.js');
    const configStore = await import('../../src/services/config-store.js');
    auth.syncTokenPoolFromConfig();

    const target = auth.getDeepSeekPoolEntries()[0];
    const id = configStore.secretId(target.token);

    const result = auth.setCredentialDisabledById(id, true);
    assert.ok(result, '应能按 id 找到并禁用');
    assert.equal(result.disabled, true);

    const row = auth.getPoolInfo().find(t => target.token.startsWith(t.token.replace('...', '')));
    assert.equal(row.disabled, true);
    assert.equal(row.disabledSource, 'manual', 'admin 禁用应记为手动');

    // 删除凭据：禁用记录应一并清理，不留脏 key。
    assert.equal(configStore.removeChannelCredential('deepseek', id), true);
    const config = readConfig();
    assert.equal(Object.keys(config.deepseek.credentialStates || {}).length, 0, '删除凭据应清掉其禁用态');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('禁用中的账号在禁用期内不会被重新登录', async () => {
  const dir = await setupEnv({ tokens: '', accounts: 'a@example.com:pw' });
  try {
    const auth = await import('../../src/services/auth.js');
    const configStore = await import('../../src/services/config-store.js');
    auth.syncTokenPoolFromConfig();

    const entry = auth.getDeepSeekPoolEntries().find(e => e.email === 'a@example.com');
    assert.ok(entry, '账号条目应存在');

    const id = configStore.secretId('a@example.com:pw');
    auth.setCredentialDisabledById(id, true);

    let loginCalls = 0;
    const restore = stubFetch({ valid: true, onLogin: () => { loginCalls++; } });
    try {
      // 池中该账号没有 token，但处于禁用态 ⇒ 不得触发登录。
      await auth.initTokenPool();
    } finally {
      restore();
    }

    assert.equal(loginCalls, 0, '禁用期内的账号不应被重新登录');
    const after = auth.getPoolInfo().find(t => t.email === 'a@example.com');
    assert.equal(after.disabled, true, '初始化后仍应保持禁用');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
