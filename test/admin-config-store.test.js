import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

function clearEnv() {
  for (const key of [
    'ZHI2API_CONFIG_PATH', 'ZHI2API_DATA_DIR', 'API_KEY', 'DS_TOKEN', 'DS_TOKENS', 'DS_ACCOUNTS',
    'GLM_REFRESH_TOKEN', 'GLM_REFRESH_TOKENS', 'QWEN_TOKENS', 'QWEN_ACCOUNTS', 'KIMI_AUTH_TOKEN', 'KIMI_AUTH_TOKENS',
  ]) delete process.env[key];
}

test('config store saves desktop config to ZHI2API_CONFIG_PATH and masks secrets', async () => {
  clearEnv();
  const dir = mkdtempSync(join(tmpdir(), 'zhi2api-config-'));
  process.env.ZHI2API_CONFIG_PATH = join(dir, 'config.json');

  const mod = await import('../src/services/config-store.js');
  mod.loadConfig({ force: true });
  mod.updateConfig({
    server: { apiKey: 'sk-secret' },
    deepseek: { tokens: ['ds-token'], accounts: [{ email: 'u@example.com', password: 'pass' }] },
    glm: { refreshTokens: ['glm-refresh'], guestMode: false },
    qwen: { tokens: ['qwen-token'] },
    kimi: { authTokens: ['kimi-token'] },
  });

  const saved = JSON.parse(readFileSync(process.env.ZHI2API_CONFIG_PATH, 'utf8'));
  assert.equal(saved.server.apiKey, 'sk-secret');
  assert.deepEqual(saved.deepseek.tokens, ['ds-token']);

  const pub = mod.getPublicConfig();
  assert.equal(pub.server.apiKeyConfigured, true);
  assert.notEqual(pub.server.apiKey, 'sk-secret');
  assert.equal(pub.deepseek.tokens[0].configured, true);
  assert.notEqual(pub.deepseek.tokens[0].label, 'ds-token');
  assert.equal(pub.deepseek.accounts[0].email, 'u@example.com');
  assert.equal(pub.deepseek.accounts[0].hasPassword, true);

  rmSync(dir, { recursive: true, force: true });
});
