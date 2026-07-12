import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';

function snapshotEnv() {
  return {
    API_KEY: process.env.API_KEY,
    API_KEYS: process.env.API_KEYS,
    GLM_REFRESH_TOKEN: process.env.GLM_REFRESH_TOKEN,
    GLM_REFRESH_TOKENS: process.env.GLM_REFRESH_TOKENS,
    GLM_GUEST_MODE: process.env.GLM_GUEST_MODE,
    ZHI2API_CONFIG_PATH: process.env.ZHI2API_CONFIG_PATH,
    ZHI2API_DATA_DIR: process.env.ZHI2API_DATA_DIR,
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
  delete process.env.GLM_REFRESH_TOKEN;
  delete process.env.GLM_REFRESH_TOKENS;
  delete process.env.GLM_GUEST_MODE;
  process.env.ZHI2API_CONFIG_PATH = join(dir, 'config.json');
  delete process.env.ZHI2API_DATA_DIR;

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

test('GLM saved refresh token is reported available after restart before access-token cache is warm', async () => {
  await withAdminServer(configStore => {
    configStore.updateConfig({
      glm: { refreshTokens: ['glm-refresh-token'], guestMode: false },
    });
  }, async baseUrl => {
    const response = await fetch(`${baseUrl}/admin/api/channels`);
    assert.equal(response.status, 200);

    const body = await response.json();
    const glm = body.channels.find(channel => channel.id === 'glm');
    assert.ok(glm);
    assert.equal(glm.configured, true);
    assert.equal(glm.credentialCount, 1);
    assert.equal(glm.availableCount, 1);
    assert.equal(glm.status, 'healthy');
  });
});
