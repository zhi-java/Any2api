import test from 'node:test';
import assert from 'node:assert/strict';

import { createChat } from '../src/channels/qwen/client.js';

test('createChat matches current Qwen web request shape for text chat', async () => {
  const originalFetch = globalThis.fetch;
  let captured = null;

  globalThis.fetch = async (url, options) => {
    captured = { url, options };
    return new Response(JSON.stringify({ success: true, data: { id: 'chat-id' } }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };

  try {
    const chatId = await createChat({
      token: 'qwen-token',
      model: 'qwen3.7-plus',
      chatMode: 't2t',
    });

    assert.equal(chatId, 'chat-id');
    assert.equal(captured.url, 'https://chat.qwen.ai/api/v2/chats/new');
    assert.equal(captured.options.headers.Authorization, 'Bearer qwen-token');
    assert.equal(captured.options.headers.Version, '0.2.68');
    assert.equal(typeof captured.options.headers['X-Request-Id'], 'string');
    assert.ok(captured.options.headers['X-Request-Id']);

    const body = JSON.parse(captured.options.body);
    assert.equal(body.chat_mode, 'normal');
    assert.equal(body.chat_type, 't2t');
    assert.deepEqual(body.models, ['qwen3.7-plus']);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('createChat reports HTML upstream responses clearly', async () => {
  const originalFetch = globalThis.fetch;
  const failures = [];

  globalThis.fetch = async () => new Response('<!doctype html><html></html>', {
    status: 200,
    headers: { 'content-type': 'text/html' },
  });

  try {
    await assert.rejects(
      () => createChat({
        token: 'qwen-token',
        model: 'qwen3.7-plus',
        chatMode: 't2t',
        tokenManager: {
          reportTokenFailure(token, info) {
            failures.push({ token, info });
          },
        },
      }),
      /Qwen create chat failed: HTTP 200 text\/html; received HTML instead of JSON/,
    );

    assert.equal(failures.length, 1);
    assert.equal(failures[0].token, 'qwen-token');
    assert.equal(failures[0].info.statusCode, 200);
    assert.match(failures[0].info.message, /Qwen\/WAF challenge/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
