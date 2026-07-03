import test from 'node:test';
import assert from 'node:assert/strict';

import { GlmTokenManager } from '../src/channels/glm/token-manager.js';

test('GlmTokenManager supports comma-separated GLM_REFRESH_TOKEN', () => {
  const originalToken = process.env.GLM_REFRESH_TOKEN;
  const originalTokens = process.env.GLM_REFRESH_TOKENS;

  process.env.GLM_REFRESH_TOKEN = 'glm-refresh-a, glm-refresh-b';
  process.env.GLM_REFRESH_TOKENS = '';

  try {
    const manager = new GlmTokenManager();
    assert.deepEqual(manager.tokens, ['glm-refresh-a', 'glm-refresh-b']);
  } finally {
    if (originalToken === undefined) delete process.env.GLM_REFRESH_TOKEN;
    else process.env.GLM_REFRESH_TOKEN = originalToken;
    if (originalTokens === undefined) delete process.env.GLM_REFRESH_TOKENS;
    else process.env.GLM_REFRESH_TOKENS = originalTokens;
  }
});

test('GlmTokenManager tries next refresh token before guest fallback', async () => {
  class TestGlmTokenManager extends GlmTokenManager {
    _loadTokens() {
      return ['bad-refresh', 'good-refresh'];
    }

    async _refresh(refreshToken) {
      this.attempted.push(refreshToken);
      if (refreshToken === 'bad-refresh') {
        throw new Error('bad refresh token');
      }
      return {
        access_token: `access-for-${refreshToken}`,
        user_id: 'good-user',
      };
    }

    async _guestAccessToken() {
      throw new Error('guest fallback should not be used');
    }
  }

  const manager = new TestGlmTokenManager();
  manager.attempted = [];

  const token = await manager.getAccessToken();

  assert.equal(token, 'access-for-good-refresh');
  assert.deepEqual(manager.attempted, ['bad-refresh', 'good-refresh']);
});
