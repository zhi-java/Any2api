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
  // 允许 configure 为 async（有些用例需要在启动服务前同步 token 池）。
  await configure(configStore);

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

// ---------------------------------------------------------------------------
// 凭据「禁用」而非删除
//
// 旧行为：测试渠道发现 token 无效时调 removeChannelCredential 物理删除配置，
// 导致风控结束后凭据永久丢失、后台也无迹可循。现在改为禁用（保留 + 可见）。
// ---------------------------------------------------------------------------

test('禁用凭据后：配置保留、池可见、计数区分可用与禁用', async () => {
  let credentialId = null;
  await withAdminServer(async configStore => {
    const auth = await import('../src/services/auth.js');
    configStore.updateConfig({ deepseek: { tokens: ['ds-stub-token'] } });
    auth.syncTokenPoolFromConfig();

    const entry = auth.getDeepSeekPoolEntries().find(e => e.token === 'ds-stub-token');
    credentialId = configStore.secretId(entry.token);
    // 模拟风控禁用（手动禁用：不自动恢复）。
    auth.setCredentialDisabledById(credentialId, true);
  }, async baseUrl => {
    // 渠道统计应区分：总数含禁用、可用数为 0、禁用数 1。
    const channelsRes = await fetch(`${baseUrl}/admin/api/channels`);
    const { channels } = await channelsRes.json();
    const deepseek = channels.find(channel => channel.id === 'deepseek');
    assert.equal(deepseek.credentialCount, 1, '总数应包含禁用凭据');
    assert.equal(deepseek.availableCount, 0, '可用数不应包含禁用凭据');
    assert.equal(deepseek.disabledCount, 1, '应单独报告禁用数');
    assert.equal(deepseek.status, 'degraded', '无可用凭据时渠道应降级');

    // 公开配置应仍能看到该凭据，且带禁用原因。
    const configRes = await fetch(`${baseUrl}/admin/api/channels/deepseek/config`);
    const { config } = await configRes.json();
    assert.equal(config.tokens.length, 1, '禁用凭据应仍保留在配置中（以前会被删除）');
    assert.equal(config.tokens[0].disabled, true);
    assert.equal(config.disabledCount, 1);

    // 通过 PATCH 启用 → 应回到可用状态。
    const patchRes = await fetch(`${baseUrl}/admin/api/channels/deepseek/credentials/${credentialId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ disabled: false }),
    });
    assert.equal(patchRes.status, 200);
    const patched = await patchRes.json();
    assert.equal(patched.config.tokens[0].disabled, false, '启用后应清除禁用态');

    // 再禁用一次，然后删除 → 配置与禁用记录都应清空。
    await fetch(`${baseUrl}/admin/api/channels/deepseek/credentials/${credentialId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ disabled: true }),
    });
    const delRes = await fetch(`${baseUrl}/admin/api/channels/deepseek/credentials/${credentialId}`, { method: 'DELETE' });
    assert.equal(delRes.status, 200);
    const afterDelete = await delRes.json();
    assert.equal(afterDelete.config.tokens.length, 0, '删除是显式操作，应真正移除凭据');
    assert.equal(afterDelete.config.disabledCount ?? 0, 0, '删除应一并清理禁用记录');
  });
});

test('PATCH 凭据禁用状态：缺少 disabled 字段应报 400，未知 id 报 404', async () => {
  await withAdminServer(configStore => {
    configStore.updateConfig({ deepseek: { tokens: ['ds-stub-token'] } });
  }, async baseUrl => {
    const badBody = await fetch(`${baseUrl}/admin/api/channels/deepseek/credentials/whatever`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    assert.equal(badBody.status, 400, '缺失 disabled 字段应报 400');

    const notFound = await fetch(`${baseUrl}/admin/api/channels/deepseek/credentials/not-a-real-id`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ disabled: true }),
    });
    assert.equal(notFound.status, 404, '未知凭据 id 应报 404');
  });
});
