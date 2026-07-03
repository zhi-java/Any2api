import test from 'node:test';
import assert from 'node:assert/strict';

import { parseQwenEvent, parseQwenStream } from '../src/channels/qwen/stream-parser.js';

function sseStream(events) {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const event of events) {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
      }
      controller.close();
    },
  });
}

test('parseQwenEvent parses answer content', () => {
  const parsed = parseQwenEvent(JSON.stringify({
    choices: [{ delta: { phase: 'answer', status: 'typing', content: '你好' } }],
  }));

  assert.deepEqual(parsed.items, [{ type: 'content', content: '你好', usage: undefined }]);
});

test('parseQwenEvent parses thinking summary content', () => {
  const parsed = parseQwenEvent(JSON.stringify({
    choices: [{
      delta: {
        phase: 'thinking_summary',
        status: 'typing',
        content: '',
        extra: { summary_thought: { content: ['先分析'] } },
      },
    }],
  }));

  assert.deepEqual(parsed.items, [{ type: 'thinking', content: '先分析', usage: undefined }]);
});

test('parseQwenEvent parses deep research phases as research events', () => {
  const parsed = parseQwenEvent(JSON.stringify({
    choices: [{
      delta: {
        phase: 'ResearchSearching',
        status: 'typing',
        content: '搜索资料',
        extra: { deep_research: { stage: 'searching' } },
      },
    }],
  }));

  assert.deepEqual(parsed.items, [{ type: 'research', content: '搜索资料', stage: 'searching', usage: undefined }]);
});

test('parseQwenEvent parses image generation output', () => {
  const parsed = parseQwenEvent(JSON.stringify({
    choices: [{ delta: { phase: 'image_gen', status: 'typing', content: 'https://cdn.example/image.png' } }],
  }));

  assert.deepEqual(parsed.items, [{ type: 'image', content: 'https://cdn.example/image.png', usage: undefined }]);
});

test('parseQwenStream emits content and done from SSE stream', async () => {
  const body = sseStream([
    { choices: [{ delta: { phase: 'answer', status: 'typing', content: 'A' } }] },
    { choices: [{ delta: { phase: 'answer', status: 'finished', content: '' } }], usage: { input_tokens: 1, output_tokens: 2 } },
  ]);

  const events = [];
  for await (const event of parseQwenStream(body)) {
    events.push(event);
  }

  assert.deepEqual(events, [
    { type: 'content', content: 'A', usage: undefined },
    { type: 'done', usage: { input_tokens: 1, output_tokens: 2 }, finishReason: 'stop' },
  ]);
});
