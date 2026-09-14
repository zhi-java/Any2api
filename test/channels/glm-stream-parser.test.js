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

// 真实上游（2026-09 实测 chatglm.cn）在同一流里混用两种编码：
//   流式阶段逐块发【增量】("1" / "." / " HTTP" / "（" ...)，
//   结束阶段再发【完整快照】(status/part status 均为 finish，重复全文)。
// 解析器若把每个事件都当快照差分，最终快照会被当成新增量重复输出一遍。
test('GLM parser handles real mixed delta-then-full-snapshot stream without duplication', async () => {
  const chunks = await collectTextUntilDone([
    'data: {"status":"init","parts":[{"status":"init","content":[{"type":"text","text":"1"}]}]}\n\n',
    'data: {"status":"init","parts":[{"status":"init","content":[{"type":"text","text":"."}]}]}\n\n',
    'data: {"status":"init","parts":[{"status":"init","content":[{"type":"text","text":" HTTP"}]}]}\n\n',
    'data: {"status":"init","parts":[{"status":"init","content":[{"type":"text","text":"（超文本传输协议）是通信协议。"}]}]}\n\n',
    'data: {"status":"init","parts":[{"status":"finish","content":[{"type":"text","text":"1. HTTP（超文本传输协议）是通信协议。"}]}]}\n\n',
    'data: {"status":"finish","parts":[{"status":"finish","content":[{"type":"text","text":"1. HTTP（超文本传输协议）是通信协议。"}]}]}\n\n',
  ].join(''));

  assert.equal(chunks.join(''), '1. HTTP（超文本传输协议）是通信协议。');
});

test('GLM parser treats a genuine full-snapshot stream as snapshot (no duplication)', async () => {
  const chunks = await collectTextUntilDone([
    'data: {"status":"init","parts":[{"content":[{"type":"text","text":"1"}]}]}\n\n',
    'data: {"status":"init","parts":[{"content":[{"type":"text","text":"1."}]}]}\n\n',
    'data: {"status":"finish","parts":[{"content":[{"type":"text","text":"1. HTTP"}]}]}\n\n',
  ].join(''));

  assert.equal(chunks.join(''), '1. HTTP');
});
