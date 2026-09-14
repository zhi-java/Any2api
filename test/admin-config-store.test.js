import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

function clearEnv() {
  for (const key of [
    'ZHI2API_CONFIG_PATH', 'ZHI2API_DATA_DIR', 'API_KEY', 'API_KEYS', 'DS_TOKEN', 'DS_TOKENS', 'DS_ACCOUNTS',
    'SESSION_TTL', 'ENABLE_CONVERSATION_AFFINITY', 'CONVERSATION_TTL_MS',
    'MAX_CONVERSATIONS', 'ENABLE_FC_ERROR_RETRY',
    'LOG_DIR', 'CLIENT_DEBUG_LOG_DIR', 'SYSTEM_FINGERPRINT',
  ]) delete process.env[key];
}

test('config store saves runtime config to ZHI2API_CONFIG_PATH and masks secrets', async () => {
  clearEnv();
  const dir = mkdtempSync(join(tmpdir(), 'omni-config-'));
  process.env.ZHI2API_CONFIG_PATH = join(dir, 'config.json');

  const mod = await import('../src/services/config-store.js');
  mod.loadConfig({ force: true });
  mod.updateConfig({
    server: { apiKey: 'sk-secret' },
    deepseek: { tokens: ['ds-token'], accounts: [{ email: 'u@example.com', password: 'pass' }] },
  });

  const saved = JSON.parse(readFileSync(process.env.ZHI2API_CONFIG_PATH, 'utf8'));
  assert.equal(saved.server.apiKey, 'sk-secret');
  assert.deepEqual(saved.deepseek.tokens, ['ds-token']);

  const pub = mod.getPublicConfig();
  assert.equal(pub.server.apiKeyConfigured, true);
  assert.notEqual(pub.server.apiKey, 'sk-secret');
  assert.equal(pub.deepseek.authMode, 'account-pool');
  assert.equal(pub.deepseek.tokenCount, 1);
  assert.deepEqual(pub.deepseek.tokens, []);
  assert.equal(pub.deepseek.accounts[0].email, 'u@example.com');
  assert.equal(pub.deepseek.accounts[0].hasPassword, true);

  rmSync(dir, { recursive: true, force: true });
});

test('config store manages external API keys separately from upstream credentials', async () => {
  clearEnv();
  const dir = mkdtempSync(join(tmpdir(), 'omni-api-keys-'));
  process.env.ZHI2API_CONFIG_PATH = join(dir, 'config.json');
  process.env.API_KEY = 'admin-and-legacy-key';

  const mod = await import('../src/services/config-store.js');
  mod.loadConfig({ force: true });
  const created = mod.addServerApiKey({ name: 'Production gateway', key: 'external-key-1' });

  assert.equal(created.key, 'external-key-1');
  assert.equal(mod.isAcceptedApiKey('admin-and-legacy-key'), true);
  assert.equal(mod.isAcceptedApiKey('external-key-1'), true);
  assert.equal(mod.isAcceptedApiKey('missing-key'), false);

  const pub = mod.getPublicConfig();
  assert.equal(pub.server.externalApiKeyCount, 2);
  assert.equal(pub.server.apiKeys[0].name, 'Production gateway');
  assert.notEqual(pub.server.apiKeys[0].label, 'external-key-1');

  assert.equal(mod.removeServerApiKey(pub.server.apiKeys[0].id), true);
  assert.equal(mod.isAcceptedApiKey('external-key-1'), false);

  rmSync(dir, { recursive: true, force: true });
});

test('config store exposes runtime env settings for admin page editing', async () => {
  clearEnv();
  const dir = mkdtempSync(join(tmpdir(), 'omni-runtime-config-'));
  process.env.ZHI2API_CONFIG_PATH = join(dir, 'config.json');
  process.env.SESSION_TTL = '90';
  process.env.ENABLE_CONVERSATION_AFFINITY = 'true';
  process.env.CONVERSATION_TTL_MS = '60000';
  process.env.MAX_CONVERSATIONS = '12';
  process.env.ENABLE_FC_ERROR_RETRY = 'false';
  process.env.LOG_DIR = join(dir, 'runtime-logs');
  process.env.CLIENT_DEBUG_LOG_DIR = join(dir, 'debug-logs');
  process.env.SYSTEM_FINGERPRINT = 'fp_test_runtime';

  const mod = await import('../src/services/config-store.js');
  mod.loadConfig({ force: true });
  let pub = mod.getPublicConfig();
  assert.equal(pub.runtime.sessionTtlSeconds, 90);
  assert.equal(pub.runtime.enableConversationAffinity, true);
  assert.equal(pub.runtime.enableFcErrorRetry, false);
  assert.equal(pub.server.clientDebugLogDir, join(dir, 'debug-logs'));
  assert.equal(pub.server.systemFingerprint, 'fp_test_runtime');

  mod.updateConfig({
    server: { systemFingerprint: 'fp_page', clientDebugLogDir: 'page-debug' },
    runtime: { sessionTtlSeconds: 120, enableFcErrorRetry: true, logDir: 'page-logs' },
  });
  pub = mod.getPublicConfig();
  assert.equal(pub.runtime.sessionTtlSeconds, 120);
  assert.equal(process.env.SESSION_TTL, '120');
  assert.equal(process.env.ENABLE_FC_ERROR_RETRY, 'true');
  assert.equal(process.env.LOG_DIR, 'page-logs');
  assert.equal(process.env.SYSTEM_FINGERPRINT, 'fp_page');

  rmSync(dir, { recursive: true, force: true });
});
