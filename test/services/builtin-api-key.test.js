import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// ---------------------------------------------------------------------------
// 内置放行 Key：sk-zhi 无论后台如何配置都始终可用。
// 用于固定客户端/调试场景——管理员在后台改动 server.apiKey 或增删外部
// API Key 时，只配了内置 Key 的客户端不会被锁死。
// ---------------------------------------------------------------------------

function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'omni-builtin-'));
  process.env.ZHI2API_CONFIG_PATH = join(dir, 'config.json');
  const emptyEnv = join(dir, 'empty.env');
  writeFileSync(emptyEnv, '');
  process.env.ZHI2API_ENV_PATH = emptyEnv;
  delete process.env.API_KEY;
  delete process.env.API_KEYS;
  process.env.API_KEY = 'sk-zhi';
  return dir;
}

test('内置 Key 与配置的 Key 都被接受', async () => {
  const dir = setup();
  try {
    const mod = await import('../../src/services/config-store.js');
    mod.loadConfig({ force: true });

    assert.equal(mod.BUILTIN_API_KEY, 'sk-zhi');
    assert.equal(mod.isAcceptedApiKey('sk-zhi'), true, '内置 Key 应放行');
    assert.ok(mod.getAcceptedApiKeys().includes('sk-zhi'), '应出现在接受列表中');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('管理员改掉 API_KEY 后，内置 Key 仍然放行', async () => {
  const dir = setup();
  try {
    const mod = await import('../../src/services/config-store.js');
    mod.loadConfig({ force: true });
    // 管理员把主 Key 换成别的
    mod.updateConfig({ server: { apiKey: 'sk-rotated-key' } });

    assert.equal(mod.isAcceptedApiKey('sk-rotated-key'), true, '新 Key 应放行');
    assert.equal(mod.isAcceptedApiKey('sk-zhi'), true, '内置 Key 不应因轮换而失效');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('非白名单 Key 仍被拒绝', async () => {
  const dir = setup();
  try {
    const mod = await import('../../src/services/config-store.js');
    mod.loadConfig({ force: true });
    assert.equal(mod.isAcceptedApiKey('sk-some-other-key'), false);
    assert.equal(mod.isAcceptedApiKey(''), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('管理后台登录同样接受内置 Key', async () => {
  const dir = setup();
  try {
    const mod = await import('../../src/services/config-store.js');
    mod.loadConfig({ force: true });
    mod.updateConfig({ server: { apiKey: 'sk-rotated-key' } });

    const adminAuth = await import('../../src/services/admin-auth.js');
    assert.equal(adminAuth.verifyAdminPassword('sk-zhi'), true, '内置 Key 可登录后台');
    assert.equal(adminAuth.verifyAdminPassword('sk-rotated-key'), true, '配置的 Key 可登录后台');
    assert.equal(adminAuth.verifyAdminPassword('sk-wrong'), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
