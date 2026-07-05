import test from 'node:test';
import assert from 'node:assert/strict';
import { ReadableStream } from 'node:stream/web';

import { parseQwenStream } from '../../src/channels/qwen/stream-parser.js';

function streamFromText(text) {
  const bytes = new TextEncoder().encode(text);
  return new ReadableStream({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
}

async function collectTextUntilDone(bodyText) {
  const chunks = [];
  for await (const event of parseQwenStream(streamFromText(bodyText))) {
    if (event.type === 'content') chunks.push(event.content);
    if (event.type === 'done') break;
  }
  return chunks.join('');
}

test('Qwen parser ignores premature empty answer finish before final text', async () => {
  const text = await collectTextUntilDone([
    'data: {"choices":[{"delta":{"role":"assistant","content":"","phase":"answer","status":"finished"}}]}\n\n',
    'data: {"choices":[{"delta":{"role":"assistant","content":"QWEN","phase":"answer","status":"typing"}}]}\n\n',
    'data: {"choices":[{"delta":{"role":"assistant","content":"_OK","phase":"answer","status":"typing"}}]}\n\n',
    'data: {"choices":[{"delta":{"role":"assistant","content":"","phase":"answer","status":"finished"}}]}\n\n',
  ].join(''));

  assert.equal(text, 'QWEN_OK');
});

test('Qwen parser preserves answer content carried by the finished event', async () => {
  const text = await collectTextUntilDone([
    'data: {"choices":[{"delta":{"role":"assistant","content":"QWEN_DONE","phase":"answer","status":"finished"}}]}\n\n',
  ].join(''));

  assert.equal(text, 'QWEN_DONE');
});
