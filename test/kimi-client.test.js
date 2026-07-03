import test from 'node:test';
import assert from 'node:assert/strict';

import { buildKimiMessages, createConnectJsonFrame, kimiChatCompletion } from '../src/channels/kimi/client.js';

function decodeConnectJsonFrame(frame) {
  const buffer = Buffer.from(frame);
  return {
    flags: buffer[0],
    length: buffer.readUInt32BE(1),
    payload: JSON.parse(buffer.subarray(5).toString('utf-8')),
  };
}

test('buildKimiMessages flattens OpenAI messages and tool results into one prompt', () => {
  const prompt = buildKimiMessages([
    { role: 'system', content: 'You are concise.' },
    { role: 'user', content: [{ type: 'text', text: 'Ping' }] },
    { role: 'assistant', content: 'Calling tool', tool_calls: [{ id: 'call_1', function: { name: 'lookup', arguments: '{}' } }] },
    { role: 'tool', tool_call_id: 'call_1', content: 'Pong' },
  ], [{
    type: 'function',
    function: {
      name: 'lookup',
      description: 'Lookup data',
      parameters: { type: 'object', properties: {} },
    },
  }]);

  assert.match(prompt, /\[System\]: You are concise\./);
  assert.match(prompt, /\[User\]: Ping/);
  assert.match(prompt, /\[Assistant tool calls\]:/);
  assert.match(prompt, /\[Tool result call_1\]: Pong/);
  assert.match(prompt, /assistant_response/);
  assert.match(prompt, /lookup/);
});

test('createConnectJsonFrame writes Connect JSON frame header and payload', () => {
  const frame = createConnectJsonFrame({ hello: 'kimi' });
  const decoded = decodeConnectJsonFrame(frame);

  assert.equal(decoded.flags, 0);
  assert.equal(decoded.length, Buffer.byteLength(JSON.stringify({ hello: 'kimi' })));
  assert.deepEqual(decoded.payload, { hello: 'kimi' });
});

test('kimiChatCompletion sends current Kimi Connect JSON request shape', async () => {
  const originalFetch = globalThis.fetch;
  let captured = null;
  const responseStream = new ReadableStream({
    start(controller) {
      controller.close();
    },
  });

  globalThis.fetch = async (url, options) => {
    captured = { url, options };
    return new Response(responseStream, { status: 200 });
  };

  try {
    const successes = [];
    const body = await kimiChatCompletion({
      token: 'kimi-token',
      prompt: 'minimal-pong',
      scenario: 'SCENARIO_K2D5',
      thinkingEnabled: true,
      tokenManager: {
        reportTokenSuccess(token) {
          successes.push(token);
        },
      },
    });

    assert.equal(body, responseStream);
    assert.equal(captured.url, 'https://www.kimi.com/apiv2/kimi.gateway.chat.v1.ChatService/Chat');
    assert.equal(captured.options.method, 'POST');
    assert.equal(captured.options.headers.Authorization, 'Bearer kimi-token');
    assert.equal(captured.options.headers['Content-Type'], 'application/connect+json');
    assert.equal(captured.options.headers.Accept, 'application/connect+json');
    assert.equal(captured.options.headers['Connect-Protocol-Version'], '1');

    const decoded = decodeConnectJsonFrame(captured.options.body);
    assert.equal(decoded.flags, 0);
    assert.equal(decoded.length, Buffer.byteLength(JSON.stringify(decoded.payload)));
    assert.equal(decoded.payload.scenario, 'SCENARIO_K2D5');
    assert.equal(decoded.payload.message.blocks[0].text.content, 'minimal-pong');
    assert.equal(decoded.payload.options.thinking, true);
    assert.equal(decoded.payload.options.enable_plugin, false);
    assert.deepEqual(successes, ['kimi-token']);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('kimiChatCompletion uploads long prompts as txt attachment blocks', async () => {
  const originalFetch = globalThis.fetch;
  const originalThreshold = process.env.KIMI_TEXT_ATTACHMENT_THRESHOLD_BYTES;
  process.env.KIMI_TEXT_ATTACHMENT_THRESHOLD_BYTES = '32';

  const calls = [];
  const responseStream = new ReadableStream({
    start(controller) {
      controller.close();
    },
  });

  globalThis.fetch = async (url, options) => {
    calls.push({ url, options });
    if (String(url).endsWith('/apiv2-files/file/upload')) {
      return new Response(JSON.stringify({ file: { id: 'uploaded-file-id' } }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    return new Response(responseStream, { status: 200 });
  };

  try {
    const prompt = 'long-kimi-prompt '.repeat(10);
    const body = await kimiChatCompletion({
      token: 'kimi-token',
      prompt,
      scenario: 'SCENARIO_K2D5',
    });

    assert.equal(body, responseStream);
    assert.equal(calls.length, 2);
    assert.equal(calls[0].url, 'https://www.kimi.com/apiv2-files/file/upload');
    assert.equal(calls[0].options.method, 'POST');
    assert.equal(calls[0].options.headers.Authorization, 'Bearer kimi-token');
    assert.equal(calls[0].options.headers['Content-Type'], undefined);
    assert.equal(calls[0].options.body instanceof FormData, true);

    const uploaded = calls[0].options.body.get('file');
    assert.equal(uploaded.name, 'any2api-long-input.txt');
    assert.equal(await uploaded.text(), prompt);

    assert.equal(calls[1].url, 'https://www.kimi.com/apiv2/kimi.gateway.chat.v1.ChatService/Chat');
    const decoded = decodeConnectJsonFrame(calls[1].options.body);
    assert.equal(decoded.payload.message.blocks.length, 2);
    assert.match(decoded.payload.message.blocks[0].text.content, /txt 附件/);
    assert.doesNotMatch(decoded.payload.message.blocks[0].text.content, /long-kimi-prompt long-kimi-prompt/);
    assert.deepEqual(decoded.payload.message.blocks[1], {
      message_id: '',
      file: {
        id: 'uploaded-file-id',
        status: 3,
        fail_reason: '',
      },
    });
  } finally {
    globalThis.fetch = originalFetch;
    if (originalThreshold === undefined) {
      delete process.env.KIMI_TEXT_ATTACHMENT_THRESHOLD_BYTES;
    } else {
      process.env.KIMI_TEXT_ATTACHMENT_THRESHOLD_BYTES = originalThreshold;
    }
  }
});

test('kimiChatCompletion uploads prompts near observed Kimi context failure size by default', async () => {
  const originalFetch = globalThis.fetch;
  const originalThreshold = process.env.KIMI_TEXT_ATTACHMENT_THRESHOLD_BYTES;
  delete process.env.KIMI_TEXT_ATTACHMENT_THRESHOLD_BYTES;

  const calls = [];
  const responseStream = new ReadableStream({
    start(controller) {
      controller.close();
    },
  });

  globalThis.fetch = async (url, options) => {
    calls.push({ url, options });
    if (String(url).endsWith('/apiv2-files/file/upload')) {
      return new Response(JSON.stringify({ file: { id: 'observed-limit-file-id' } }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    return new Response(responseStream, { status: 200 });
  };

  try {
    await kimiChatCompletion({
      token: 'kimi-token',
      prompt: 'A'.repeat(513619),
      scenario: 'SCENARIO_K2D5',
    });

    assert.equal(calls.length, 2);
    assert.equal(calls[0].url, 'https://www.kimi.com/apiv2-files/file/upload');
    assert.equal(calls[1].url, 'https://www.kimi.com/apiv2/kimi.gateway.chat.v1.ChatService/Chat');
    const decoded = decodeConnectJsonFrame(calls[1].options.body);
    assert.equal(decoded.payload.message.blocks[1].file.id, 'observed-limit-file-id');
  } finally {
    globalThis.fetch = originalFetch;
    if (originalThreshold === undefined) {
      delete process.env.KIMI_TEXT_ATTACHMENT_THRESHOLD_BYTES;
    } else {
      process.env.KIMI_TEXT_ATTACHMENT_THRESHOLD_BYTES = originalThreshold;
    }
  }
});

test('kimiChatCompletion keeps prompts below default text attachment threshold inline', async () => {
  const originalFetch = globalThis.fetch;
  const originalThreshold = process.env.KIMI_TEXT_ATTACHMENT_THRESHOLD_BYTES;
  delete process.env.KIMI_TEXT_ATTACHMENT_THRESHOLD_BYTES;

  const calls = [];
  const responseStream = new ReadableStream({
    start(controller) {
      controller.close();
    },
  });

  globalThis.fetch = async (url, options) => {
    calls.push({ url, options });
    return new Response(responseStream, { status: 200 });
  };

  try {
    await kimiChatCompletion({
      token: 'kimi-token',
      prompt: 'A'.repeat(440000),
      scenario: 'SCENARIO_K2D5',
    });

    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, 'https://www.kimi.com/apiv2/kimi.gateway.chat.v1.ChatService/Chat');
  } finally {
    globalThis.fetch = originalFetch;
    if (originalThreshold === undefined) {
      delete process.env.KIMI_TEXT_ATTACHMENT_THRESHOLD_BYTES;
    } else {
      process.env.KIMI_TEXT_ATTACHMENT_THRESHOLD_BYTES = originalThreshold;
    }
  }
});
