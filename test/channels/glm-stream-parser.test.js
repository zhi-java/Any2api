import test from 'node:test';
import assert from 'node:assert/strict';
import { ReadableStream } from 'node:stream/web';

import { parseGLMStream } from '../../src/channels/glm/stream-parser.js';

function streamFromText(text) {
  const bytes = new TextEncoder().encode(text);
  return new ReadableStream({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
}

async function collectTextEvents(bodyText) {
  const events = [];
  for await (const event of parseGLMStream(streamFromText(bodyText))) {
    if (event.type === 'content') events.push(event.content);
  }
  return events;
}

async function collectTextUntilDone(bodyText) {
  const events = [];
  for await (const event of parseGLMStream(streamFromText(bodyText))) {
    if (event.type === 'content') events.push(event.content);
    if (event.type === 'done') break;
  }
  return events;
}

test('GLM parser preserves all standard SSE delta chunks', async () => {
  const chunks = await collectTextEvents([
    'data: {"choices":[{"delta":{"content":"HEL"}}]}\n\n',
    'data: {"choices":[{"delta":{"content":"LO"}}]}\n\n',
    'data: {"choices":[{"delta":{"content":"_OK"}}]}\n\n',
    'data: [DONE]\n\n',
  ].join(''));

  assert.equal(chunks.join(''), 'HELLO_OK');
});

test('GLM parser still converts Web snapshot parts into deltas', async () => {
  const chunks = await collectTextEvents([
    'data: {"parts":[{"content":[{"type":"text","text":"HEL"}]}]}\n\n',
    'data: {"parts":[{"content":[{"type":"text","text":"HELLO"}]}]}\n\n',
    'data: {"parts":[{"content":[{"type":"text","text":"HELLO_OK"}]}]}\n\n',
  ].join(''));

  assert.deepEqual(chunks, ['HEL', 'LO', '_OK']);
});

test('GLM parser ignores Web search tool finish events before final text', async () => {
  const chunks = await collectTextUntilDone([
    'data: {"status":"init","parts":[{"role":"assistant","status":"finish","content":[{"type":"tool_calls","tool_calls":{"id":"tool_1","name":"retrieve","arguments":"{}"}}]}]}\n\n',
    'data: {"status":"init","parts":[{"role":"tool","status":"finish","content":[{"type":"tool_result","tool_calls":{"id":"tool_1","name":"retrieve","arguments":"{}"}}]}]}\n\n',
    'data: {"status":"init","parts":[{"role":"assistant","status":"finish","content":[{"type":"text","text":"GLM_SEARCH_OK","tool_calls":{}}]}]}\n\n',
    'data: {"status":"finish","parts":[{"role":"assistant","status":"finish","content":[{"type":"text","text":"GLM_SEARCH_OK","tool_calls":{}}]}]}\n\n',
  ].join(''));

  assert.deepEqual(chunks, ['GLM_SEARCH_OK']);
});
