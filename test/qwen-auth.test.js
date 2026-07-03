import test from 'node:test';
import assert from 'node:assert/strict';

import { QwenTokenManager } from '../src/channels/qwen/auth.js';

function fakeJwt(id) {
  const header = Buffer.from(JSON.stringify({ alg: 'none' })).toString('base64url');
  const payload = Buffer.from(JSON.stringify({
    id,
    exp: Math.floor(Date.now() / 1000) + 3600,
  })).toString('base64url');
  return `${header}.${payload}.sig`;
}

test('QwenTokenManager reports HTML login responses clearly', async () => {
  const originalAccounts = process.env.QWEN_ACCOUNTS;
  const originalFetch = globalThis.fetch;

  process.env.QWEN_ACCOUNTS = 'user@example.com:password';
  globalThis.fetch = async () => new Response('<!doctype html><html></html>', {
    status: 200,
    headers: { 'content-type': 'text/html' },
  });

  try {
    const manager = new QwenTokenManager();
    const slot = await manager.acquireToken();
    assert.equal(slot, null);
    assert.match(manager.getPoolInfo()[0].lastError, /received HTML instead of JSON/);
  } finally {
    if (originalAccounts === undefined) delete process.env.QWEN_ACCOUNTS;
    else process.env.QWEN_ACCOUNTS = originalAccounts;
    globalThis.fetch = originalFetch;
  }
});

test('QwenTokenManager supports comma-separated accounts and tries next account on login failure', async () => {
  const originalAccounts = process.env.QWEN_ACCOUNTS;
  const originalTokens = process.env.QWEN_TOKENS;
  const originalFetch = globalThis.fetch;
  const attempted = [];

  process.env.QWEN_ACCOUNTS = 'bad@example.com:bad-password,good@example.com:good-password';
  process.env.QWEN_TOKENS = '';

  globalThis.fetch = async (_url, options = {}) => {
    const body = JSON.parse(options.body);
    attempted.push(body.email);
    if (body.email === 'bad@example.com') {
      return new Response(JSON.stringify({ detail: 'bad credentials' }), {
        status: 401,
        headers: { 'content-type': 'application/json' },
      });
    }
    return new Response(JSON.stringify({ token: fakeJwt('good@example.com') }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };

  try {
    const manager = new QwenTokenManager();
    const slot = await manager.acquireToken();

    assert.equal(slot.account.email, 'good@example.com');
    assert.deepEqual(attempted, ['bad@example.com', 'good@example.com']);
    slot.release();
  } finally {
    if (originalAccounts === undefined) delete process.env.QWEN_ACCOUNTS;
    else process.env.QWEN_ACCOUNTS = originalAccounts;
    if (originalTokens === undefined) delete process.env.QWEN_TOKENS;
    else process.env.QWEN_TOKENS = originalTokens;
    globalThis.fetch = originalFetch;
  }
});
