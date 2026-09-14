import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// ---------------------------------------------------------------------------
// 多凭据故障转移：一个凭据被限流时，应换池中其它凭据重试，而不是把错误
// 直接抛给客户端。这是"配置多个上游凭证"的核心价值。
// ---------------------------------------------------------------------------

function setupEnv() {
  const dir = mkdtempSync(join(tmpdir(), 'omni-failover-'));
  process.env.ZHI2API_CONFIG_PATH = join(dir, 'config.json');
  const emptyEnv = join(dir, 'empty.env');
  writeFileSync(emptyEnv, '');
  process.env.ZHI2API_ENV_PATH = emptyEnv;
  delete process.env.DS_TOKEN;
  delete process.env.DS_ACCOUNTS;
  process.env.DS_TOKENS = 'token-AAA, token-BBB, token-CCC';
  return dir;
}

test('限流凭据进入冷却，不再参与分配', async () => {
  const dir = setupEnv();
  try {
    const auth = await import('../../src/services/auth.js');
    auth.syncTokenPoolFromConfig();

    const first = auth.acquireToken();
    assert.ok(first, '应能取到凭据');

    // 上报限流：该凭据应进入冷却
    const { cooldownSeconds } = auth.reportTokenRateLimited(first.token);
    assert.ok(cooldownSeconds > 0, '限流应产生冷却时长');
    first.release();

    // 冷却中的凭据不应再被分配
    const acquired = [];
    for (let i = 0; i < 10; i++) {
      const slot = auth.acquireToken();
      if (!slot) break;
      acquired.push(slot.token);
      slot.release();
    }
    assert.ok(acquired.length > 0, '应仍有其它凭据可用');
    assert.equal(
      acquired.includes(first.token), false,
      '冷却中的凭据不应再被分配',
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('连续限流按指数退避递增冷却时长', async () => {
  const dir = setupEnv();
  try {
    const auth = await import('../../src/services/auth.js');
    auth.syncTokenPoolFromConfig();
    const slot = auth.acquireToken();
    const token = slot.token;
    slot.release();

    const first = auth.reportTokenRateLimited(token).cooldownSeconds;
    const second = auth.reportTokenRateLimited(token).cooldownSeconds;
    const third = auth.reportTokenRateLimited(token).cooldownSeconds;
    assert.ok(second > first, `第 2 次冷却应长于第 1 次 (${second} > ${first})`);
    assert.ok(third > second, `第 3 次冷却应长于第 2 次 (${third} > ${second})`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('成功上报清除冷却与限流计数', async () => {
  const dir = setupEnv();
  try {
    const auth = await import('../../src/services/auth.js');
    auth.syncTokenPoolFromConfig();
    const slot = auth.acquireToken();
    const token = slot.token;
    slot.release();

    auth.reportTokenRateLimited(token);
    const cooling = auth.getPoolInfo().find(t => token.startsWith(t.token.replace('...', '')));
    assert.ok(cooling.cooldownRemainingMs > 0, '应处于冷却中');

    auth.reportTokenSuccess(token);
    const cleared = auth.getPoolInfo().find(t => token.startsWith(t.token.replace('...', '')));
    assert.equal(cleared.cooldownRemainingMs, 0, '成功后应清除冷却');
    assert.equal(cleared.rateLimitHits, 0, '成功后应清除限流计数');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('hasAlternativeToken 排除指定凭据，且不把冷却中的算作可用', async () => {
  const dir = setupEnv();
  try {
    const auth = await import('../../src/services/auth.js');
    auth.syncTokenPoolFromConfig();

    // 逐个取出并立即释放，收集池中全部凭据（避免受并发上限影响）。
    // 先清掉前序测试可能残留的冷却，保证本次从干净状态开始。
    for (const entry of auth.getPoolInfo()) {
      auth.clearTokenRateLimit(entry.token.replace('...', ''));
    }

    const tokens = [];
    for (let i = 0; i < 3; i++) {
      const slot = auth.acquireToken();
      if (!slot) continue;
      if (!tokens.includes(slot.token)) tokens.push(slot.token);
      slot.release();
    }
    assert.equal(tokens.length, 3, '应能识别池中 3 个凭据');

    assert.equal(auth.hasAlternativeToken(tokens[0]), true, '还有其它凭据');

    // 把除第一个外全部冷却 → 不应再有替代
    auth.reportTokenRateLimited(tokens[1]);
    auth.reportTokenRateLimited(tokens[2]);
    assert.equal(auth.hasAlternativeToken(tokens[0]), false, '其它凭据均在冷却中');
    assert.equal(auth.hasAlternativeToken(tokens[1]), true, '第一个仍可用');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('限流最终失败应回报 429 语义，而非 502', async () => {
  const { errorToResponseError } = await import('../../src/core/errors.js');

  // 所有凭据耗尽时 completion 抛出的最终错误应带 429
  const limited = new Error('Rate limited (429)');
  limited.status = 429;
  limited.type = 'rate_limit_error';
  const mapped = errorToResponseError(limited);
  assert.equal(mapped.status, 429, '限流应映射为 HTTP 429');
  assert.equal(mapped.error.type, 'rate_limit_error');

  // 普通上游错误仍是 502
  const upstream = new Error('upstream boom');
  upstream.status = 502;
  assert.equal(errorToResponseError(upstream).status, 502);
});

test('凭据相关错误被正确识别为可故障转移（含 40003 等原先遗漏的分支）', async () => {
  const { isCredentialRelatedError } = await import('../../src/utils/sse.js');

  // 应触发故障转移：凭据失效 / 临时受限
  for (const message of [
    'Token invalid (40003)',
    'Account banned (40004)',
    'Account requires verification: a@b.com',
    'Session create failed: {"code":40003}',
    'Rate limited (429)',
    'DeepSeek user muted (biz_code=5) until 123: user is muted',
    'Session rate limited (40301) — sessions rotated',
  ]) {
    assert.equal(isCredentialRelatedError(new Error(message)), true, `应可转移: ${message}`);
  }

  // 不应触发（换了凭据也没用）
  for (const message of [
    'Unknown model: foo',
    'prompt is required',
    'input is required',
  ]) {
    assert.equal(isCredentialRelatedError(new Error(message)), false, `不应转移: ${message}`);
  }

  // 显式标记优先
  const marked = new Error('arbitrary');
  marked.credentialFailover = true;
  assert.equal(isCredentialRelatedError(marked), true);
});
