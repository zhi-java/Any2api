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

async function withServer(fn) {
  const env = snapshotEnv();
  const dir = mkdtempSync(join(tmpdir(), 'omni-admin-auth-'));
  process.env.API_KEY = 'test-admin-key';
  delete process.env.API_KEYS;
  process.env.ZHI2API_CONFIG_PATH = join(dir, 'config.json');
  delete process.env.ZHI2API_DATA_DIR;

  const { loadConfig } = await import('../src/services/config-store.js');
  loadConfig({ force: true });
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

async function get(baseUrl, path, headers = {}) {
  const response = await fetch(`${baseUrl}${path}`, { headers, redirect: 'manual' });
  return {
    status: response.status,
    location: response.headers.get('location'),
    contentType: response.headers.get('content-type') || '',
    text: await response.text(),
  };
}

test('root endpoint renders guest project introduction page', async () => {
  await withServer(async baseUrl => {
    const response = await get(baseUrl, '/', { Accept: 'text/html' });
    assert.equal(response.status, 200);
    assert.match(response.contentType, /text\/html/);
    assert.match(response.text, /OmniAPI/);
    assert.match(response.text, /Multi-channel Web-to-API Proxy/);
    assert.doesNotMatch(response.text, /"pool"|"queue"|"totalCapacity"/);
  });
});

test('health endpoint keeps JSON liveness response', async () => {
  await withServer(async baseUrl => {
    const response = await get(baseUrl, '/healthz', { Accept: 'application/json' });
    assert.equal(response.status, 200);
    const body = JSON.parse(response.text);
    assert.equal(body.status, 'ok');
    assert.equal(body.version, '1.0.0');
  });
});

test('unknown browser route falls back to guest introduction page', async () => {
  await withServer(async baseUrl => {
    const response = await get(baseUrl, '/missing-page', { Accept: 'text/html' });
    assert.equal(response.status, 200);
    assert.match(response.contentType, /text\/html/);
    assert.match(response.text, /把多个上游 Web 模型统一成可调用 API/);
  });
});

test('unknown api route keeps JSON 404 after authentication', async () => {
  await withServer(async baseUrl => {
    const response = await get(baseUrl, '/v1/unknown', { Accept: 'application/json', Authorization: 'Bearer test-admin-key' });
    assert.equal(response.status, 404);
    assert.match(response.text, /Not found/);
  });
});

test('admin SPA shell is served unauthenticated (login page lives in the bundle)', async () => {
  await withServer(async baseUrl => {
    const response = await get(baseUrl, '/admin');
    assert.equal(response.status, 200);
    assert.match(response.text, /OmniAPI 控制台|id="root"/);
    // bundle 内不得内联任何上游凭据或 API Key
    assert.doesNotMatch(response.text, /sk-[A-Za-z0-9]{20,}/);
  });
});

test('admin data APIs require authentication', async () => {
  await withServer(async baseUrl => {
    for (const path of ['/admin/api/config', '/admin/api/channels', '/admin/api/stats']) {
      const response = await get(baseUrl, path);
      assert.equal(response.status, 401, `${path} must require auth`);
    }
  });
});

test('admin data APIs respond with bearer authentication', async () => {
  await withServer(async baseUrl => {
    const response = await get(baseUrl, '/admin/api/auth/status', { Authorization: 'Bearer test-admin-key' });
    assert.equal(response.status, 200);
  });
});

test('performance page does not expose standalone metrics UI unauthenticated', async () => {
  await withServer(async baseUrl => {
    const response = await get(baseUrl, '/performance');
    assert.ok([302, 303, 307, 308, 401].includes(response.status));
    assert.doesNotMatch(response.text, /性能监控|实时模型指标|chartRpm/);
  });
});

test('performance api requires authentication', async () => {
  await withServer(async baseUrl => {
    const response = await get(baseUrl, '/performance/api/metrics');
    assert.equal(response.status, 401);
    assert.doesNotMatch(response.text, /perModel|tokenSpeed|ttfbP50/);
  });
});

test('v1 api accepts managed external API keys', async () => {
  await withServer(async baseUrl => {
    const { addServerApiKey } = await import('../src/services/config-store.js');
    addServerApiKey({ name: 'client', key: 'external-client-key' });

    const denied = await get(baseUrl, '/v1/models');
    assert.equal(denied.status, 401);

    const allowed = await get(baseUrl, '/v1/models', { Authorization: 'Bearer external-client-key' });
    assert.equal(allowed.status, 200);
    assert.match(allowed.text, /"object":"list"/);
  });
});
