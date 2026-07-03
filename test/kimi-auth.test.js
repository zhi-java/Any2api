import test from 'node:test';
import assert from 'node:assert/strict';

import { KimiTokenManager } from '../src/channels/kimi/auth.js';

test('KimiTokenManager supports comma-separated KIMI_AUTH_TOKEN and avoids failed token first', () => {
  const originalToken = process.env.KIMI_AUTH_TOKEN;
  const originalTokens = process.env.KIMI_AUTH_TOKENS;

  process.env.KIMI_AUTH_TOKEN = 'kimi-token-a,kimi-token-b';
  process.env.KIMI_AUTH_TOKENS = '';

  try {
    const manager = new KimiTokenManager();

    const first = manager.acquireToken();
    assert.equal(first.token, 'kimi-token-a');
    first.release();

    manager.reportTokenFailure('kimi-token-a', 'HTTP 503');

    const second = manager.acquireToken();
    assert.equal(second.token, 'kimi-token-b');
    second.release();
  } finally {
    if (originalToken === undefined) delete process.env.KIMI_AUTH_TOKEN;
    else process.env.KIMI_AUTH_TOKEN = originalToken;
    if (originalTokens === undefined) delete process.env.KIMI_AUTH_TOKENS;
    else process.env.KIMI_AUTH_TOKENS = originalTokens;
  }
});
