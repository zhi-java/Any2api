import test from 'node:test';
import assert from 'node:assert/strict';

import { parseSSEStream } from '../../src/utils/sse.js';

function streamFromSseObjects(objects) {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const object of objects) {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(object)}\n\n`));
      }
      controller.close();
    },
  });
}

async function collect(body) {
  const events = [];
  for await (const event of parseSSEStream(body)) events.push(event);
  return events;
}

test('parseSSEStream does not classify first response fragment char as thinking after THINK prelude', async () => {
  const events = await collect(streamFromSseObjects([
    {
      v: {
        response: {
          fragments: [
            { type: 'THINK', content: '先思考。' },
          ],
        },
      },
    },
    { p: 'response/fragments/1/content', o: 'APPEND', v: '北' },
    { p: 'response/fragments/1/content', o: 'APPEND', v: '京' },
    { p: 'response/status', o: 'REPLACE', v: 'FINISHED' },
  ]));

  assert.deepEqual(events.map(e => [e.type, e.content].filter(v => v !== undefined)), [
    ['thinking', '先思考。'],
    ['content', '北'],
    ['content', '京'],
    ['done'],
  ]);
});

test('parseSSEStream keeps known THINK fragment content as thinking', async () => {
  const events = await collect(streamFromSseObjects([
    {
      v: {
        response: {
          fragments: [
            { type: 'THINK', content: '' },
            { type: 'RESPONSE', content: '' },
          ],
        },
      },
    },
    { p: 'response/fragments/0/content', o: 'APPEND', v: '思' },
    { p: 'response/fragments/1/content', o: 'APPEND', v: '答' },
  ]));

  assert.deepEqual(events.map(e => [e.type, e.content].filter(v => v !== undefined)), [
    ['thinking', '思'],
    ['content', '答'],
  ]);
});
