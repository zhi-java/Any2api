import test from 'node:test';
import assert from 'node:assert/strict';

import { createConnectJsonFrame } from '../src/channels/kimi/client.js';
import { parseKimiFrameForTest, parseKimiStream } from '../src/channels/kimi/stream-parser.js';

function connectStream(payloads) {
  return new ReadableStream({
    start(controller) {
      for (const payload of payloads) {
        controller.enqueue(createConnectJsonFrame(payload));
      }
      controller.close();
    },
  });
}

test('parseKimiFrameForTest parses set block text content', () => {
  const events = parseKimiFrameForTest(JSON.stringify({
    op: 'set',
    mask: 'block.text',
    block: { text: { content: 'minimal' } },
  }));

  assert.deepEqual(events, [{ type: 'content', content: 'minimal' }]);
});

test('parseKimiFrameForTest parses append block text content', () => {
  const events = parseKimiFrameForTest(JSON.stringify({
    op: 'append',
    mask: 'block.text.content',
    block: { text: { content: '-pong' } },
  }));

  assert.deepEqual(events, [{ type: 'content', content: '-pong' }]);
});

test('parseKimiFrameForTest parses done payload', () => {
  assert.deepEqual(parseKimiFrameForTest(JSON.stringify({ done: {} })), [{ type: 'done' }]);
});

test('parseKimiFrameForTest parses trailer errors', () => {
  const events = parseKimiFrameForTest(JSON.stringify({
    error: { code: 'unauthenticated', message: 'token expired' },
  }), 2);

  assert.deepEqual(events, [{ type: 'error', message: 'token expired' }]);
});

test('parseKimiFrameForTest parses Kimi block exception errors', () => {
  const events = parseKimiFrameForTest(JSON.stringify({
    op: 'set',
    mask: 'block.exception',
    block: {
      exception: {
        error: {
          reason: 'REASON_TOKEN_LENGTH_TOO_LONG',
          localizedMessage: {
            locale: 'en-US',
            message: 'Your conversation with Kimi is getting too long. Try starting a new session.',
          },
        },
      },
    },
  }));

  assert.deepEqual(events, [{
    type: 'error',
    message: 'Your conversation with Kimi is getting too long. Try starting a new session.',
  }]);
});

test('parseKimiStream emits content and done from Connect JSON frames', async () => {
  const body = connectStream([
    { op: 'set', mask: 'block.text', block: { text: { content: 'minimal' } } },
    { op: 'append', mask: 'block.text.content', block: { text: { content: '-pong' } } },
    { done: {} },
  ]);

  const events = [];
  for await (const event of parseKimiStream(body)) {
    events.push(event);
  }

  assert.deepEqual(events, [
    { type: 'content', content: 'minimal' },
    { type: 'content', content: '-pong' },
    { type: 'done' },
  ]);
});
