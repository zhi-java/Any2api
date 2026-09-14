import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';

function snapshotEnv() {
  return {
    API_KEY: process.env.API_KEY,
    API_KEYS: process.env.API_KEYS,
    DS_TOKEN: process.env.DS_TOKEN,
    DS_TOKENS: process.env.DS_TOKENS,
    DS_ACCOUNTS: process.env.DS_ACCOUNTS,
    ZHI2API_CONFIG_PATH: process.env.ZHI2API_CONFIG_PATH,
    ZHI2API_DATA_DIR: process.env.ZHI2API_DATA_DIR,
    ZHI2API_ENV_PATH: process.env.ZHI2API_ENV_PATH,
  };
}

function restoreEnv(snapshot) {
  for (const [key, value] of Object.entries(snapshot)) {
    if (value == null) delete process.env[key];
    else process.env[key] = value;
  }
}

async function withAdminServer(configure, fn) {
  const env = snapshotEnv();
  const dir = mkdtempSync(join(tmpdir(), 'omni-admin-channels-'));
  delete process.env.API_KEY;
  delete process.env.API_KEYS;
  delete process.env.DS_TOKEN;
  delete process.env.DS_TOKENS;
  delete process.env.DS_ACCOUNTS;
  process.env.ZHI2API_CONFIG_PATH = join(dir, 'config.json');
  delete process.env.ZHI2API_DATA_DIR;
  // 隔离宿主机 .env：loadEnvironment() 会按候选路径回退读取，
  // 若指向不存在的文件它会继续找 cwd/.env，把删掉的 API_KEY 读回来，
  // 使本测试误判为"需要鉴权"。这里放一个真实的空 env 文件，确保命中即停。
  const emptyEnvPath = join(dir, 'empty.env');
  writeFileSync(emptyEnvPath, '');
  process.env.ZHI2API_ENV_PATH = emptyEnvPath;

  const configStore = await import('../src/services/config-store.js');
  configStore.loadConfig({ force: true });
  configure(configStore);

  const { createApp } = await import('../src/server.js');
  const server = createServer(createApp());
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();

  try {
    return await fn(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise(resolve => server.close(resolve));
    restoreEnv(env);
    rmSync(dir, { recursive: true, force: true });
  }
}

test('DeepSeek 渠道在无凭据时报告为未配置', async () => {
  await withAdminServer(() => {}, async baseUrl => {
    const response = await fetch(`${baseUrl}/admin/api/channels`);
    assert.equal(response.status, 200);

    const body = await response.json();
    // GLM 渠道已移除，只剩 DeepSeek
    assert.equal(body.channels.length, 1);
    const deepseek = body.channels.find(channel => channel.id === 'deepseek');
    assert.ok(deepseek);
    assert.equal(deepseek.configured, false);
    assert.equal(deepseek.status, 'unconfigured');
  });
});

test('DeepSeek 已保存 token 时按配置报告为已配置', async () => {
  await withAdminServer(configStore => {
    // 仅写入配置（不触发 token 池同步），验证 configured 判据来自配置本身
    configStore.updateConfig({ deepseek: { tokens: ['ds-probe-token'] } });
  }, async baseUrl => {
    const response = await fetch(`${baseUrl}/admin/api/channels`);
    assert.equal(response.status, 200);

    const body = await response.json();
    const deepseek = body.channels.find(channel => channel.id === 'deepseek');
    assert.ok(deepseek);
    assert.equal(deepseek.configured, true);
    assert.equal(deepseek.mode, 'token-pool');
  });
});
