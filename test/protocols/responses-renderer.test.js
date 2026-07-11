import test from 'node:test';
import assert from 'node:assert/strict';

import { getResponseToolCallIndex } from '../../src/services/conversation.js';
import { renderResponsesJSON, renderResponsesStream } from '../../src/protocols/responses/renderer.js';
import {
  createMessageDone,
  createMessageStarted,
  createReasoningDelta,
  createReasoningDone,
  createRunCompleted,
  createRunStarted,
  createTextDelta,
  createTextDone,
  createToolCallArgumentsDelta,
  createToolCallDone,
  createToolCallStarted,
} from '../../src/core/internal-events.js';

function events() {
  const requestId = 'req_test';
  const responseId = 'resp_test';
  const messageId = 'msg_test';
  return [
    createRunStarted({ requestId, responseId, model: 'deepseek-v4-flash', protocol: 'responses', created: 123 }),
    createMessageStarted({ requestId, responseId, messageId }),
    createTextDelta({ requestId, responseId, messageId, delta: 'hel' }),
    createTextDelta({ requestId, responseId, messageId, delta: 'lo' }),
    createTextDone({ requestId, responseId, messageId, text: 'hello' }),
    createMessageDone({ requestId, responseId, messageId }),
    createRunCompleted({ requestId, responseId, finishReason: 'stop', usage: { inputTokens: 2, outputTokens: 3 } }),
  ];
}

async function* asyncEvents(items) {
  for (const item of items) yield item;
}

function jsonRes() {
  return {
    statusCode: 200,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
  };
}

function streamRes() {
  return {
    headers: null,
    chunks: [],
    writableEnded: false,
    destroyed: false,
    socket: { setNoDelay() {} },
    writeHead(status, headers) { this.statusCode = status; this.headers = headers; },
    write(chunk) { this.chunks.push(String(chunk)); },
    end() { this.writableEnded = true; },
  };
}

test('Responses JSON renderer aggregates output_text and usage', async () => {
  const res = jsonRes();
  await renderResponsesJSON(res, asyncEvents(events()), { model: 'deepseek-v4-flash' });
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.object, 'response');
  assert.equal(res.body.status, 'completed');
  assert.equal(res.body.output_text, 'hello');
  assert.equal(res.body.output[0].content[0].text, 'hello');
  assert.equal(res.body.usage.input_tokens, 2);
  assert.equal(res.body.usage.output_tokens, 3);
});

test('Responses stream renderer emits Responses event names', async () => {
  const res = streamRes();
  await renderResponsesStream(res, asyncEvents(events()), { model: 'deepseek-v4-flash' });
  const wire = res.chunks.join('');
  assert.match(wire, /event: response\.created/);
  assert.match(wire, /event: response\.output_item\.added/);
  assert.match(wire, /event: response\.content_part\.added/);
  assert.match(wire, /event: response\.output_text\.delta/);
  assert.match(wire, /event: response\.output_text\.done/);
  assert.match(wire, /event: response\.completed/);
  assert.doesNotMatch(wire, /chat\.completion\.chunk/);
});

test('Responses stream renderer closes empty text content parts', async () => {
  const requestId = 'req_empty';
  const responseId = 'resp_empty';
  const messageId = 'msg_empty';
  const res = streamRes();
  await renderResponsesStream(res, asyncEvents([
    createRunStarted({ requestId, responseId, model: 'deepseek-v4-flash', protocol: 'responses' }),
    createMessageStarted({ requestId, responseId, messageId }),
    createRunCompleted({ requestId, responseId, finishReason: 'stop' }),
  ]), { model: 'deepseek-v4-flash' });
  const wire = res.chunks.join('');
  assert.match(wire, /event: response\.content_part\.added/);
  assert.match(wire, /event: response\.output_text\.done/);
  assert.match(wire, /event: response\.content_part\.done/);
});

test('Responses stream renderer emits reasoning summary events before text', async () => {
  const requestId = 'req_reasoning';
  const responseId = 'resp_reasoning';
  const messageId = 'msg_reasoning';
  const res = streamRes();
  await renderResponsesStream(res, asyncEvents([
    createRunStarted({ requestId, responseId, model: 'deepseek-v4-flash', protocol: 'responses' }),
    createReasoningDelta({ requestId, responseId, messageId, delta: '先分析需求。' }),
    createReasoningDone({ requestId, responseId, messageId, text: '先分析需求。' }),
    createMessageStarted({ requestId, responseId, messageId }),
    createTextDelta({ requestId, responseId, messageId, delta: '结果' }),
    createRunCompleted({ requestId, responseId, finishReason: 'stop' }),
  ]), { model: 'deepseek-v4-flash' });
  const wire = res.chunks.join('');
  assert.match(wire, /event: response\.reasoning_summary_part\.added/);
  assert.match(wire, /event: response\.reasoning_summary_text\.delta/);
  assert.match(wire, /"delta":"先分析需求。"/);
  assert.ok(wire.indexOf('response.reasoning_summary_text.delta') < wire.indexOf('response.output_text.delta'));
  const completed = wire.split('\n').filter(line => line.startsWith('data: ')).map(line => JSON.parse(line.slice(6))).find(p => p.type === 'response.completed');
  assert.equal(completed.response.output[0].type, 'reasoning');
  assert.equal(completed.response.output[0].summary[0].text, '先分析需求。');
  assert.equal(completed.response.output[1].type, 'message');
});

test('Responses stream renderer keeps tool call output indices consistent', async () => {
  const requestId = 'req_tool';
  const responseId = 'resp_tool';
  const messageId = 'msg_tool';
  const res = streamRes();
  await renderResponsesStream(res, asyncEvents([
    createRunStarted({ requestId, responseId, model: 'deepseek-v4-flash', protocol: 'responses' }),
    createMessageStarted({ requestId, responseId, messageId }),
    createToolCallStarted({ requestId, responseId, messageId, toolCallId: 'call_1', index: 0, name: 'Read' }),
    createToolCallArgumentsDelta({ requestId, responseId, messageId, toolCallId: 'call_1', index: 0, delta: '{"file_path"' }),
    createToolCallDone({ requestId, responseId, messageId, toolCallId: 'call_1', index: 0, name: 'Read', arguments: '{"file_path":"README.md"}' }),
    createRunCompleted({ requestId, responseId, finishReason: 'tool_calls' }),
  ]), { model: 'deepseek-v4-flash' });
  const payloads = res.chunks.join('').split('\n').filter(line => line.startsWith('data: ')).map(line => JSON.parse(line.slice(6)));
  const added = payloads.find(p => p.type === 'response.output_item.added' && p.item?.type === 'function_call');
  const delta = payloads.find(p => p.type === 'response.function_call_arguments.delta');
  const done = payloads.find(p => p.type === 'response.function_call_arguments.done');
  assert.equal(added.output_index, 1);
  assert.equal(delta.output_index, added.output_index);
  assert.equal(done.output_index, added.output_index);
  const recorded = getResponseToolCallIndex(responseId);
  assert.deepEqual(recorded.get('call_1'), { name: 'Read', arguments: '{"file_path":"README.md"}' });
});

test('Responses stream records tool call before stream completion for immediate follow-up tool output', async () => {
  const requestId = 'req_tool_early';
  const responseId = 'resp_tool_early';
  const messageId = 'msg_tool_early';
  const res = streamRes();
  async function* interruptedEvents() {
    yield createRunStarted({ requestId, responseId, model: 'deepseek-v4-flash', protocol: 'responses' });
    yield createToolCallDone({ requestId, responseId, messageId, toolCallId: 'call_early', index: 0, name: 'Read', arguments: '{"file_path":"README.md"}' });
    assert.deepEqual(getResponseToolCallIndex(responseId).get('call_early'), { name: 'Read', arguments: '{"file_path":"README.md"}' });
  }
  await renderResponsesStream(res, interruptedEvents(), { model: 'deepseek-v4-flash' });
});

test('Responses stream renderer adds fallback tool item for tool_call.done only', async () => {
  const requestId = 'req_tool_done';
  const responseId = 'resp_tool_done';
  const messageId = 'msg_tool_done';
  const res = streamRes();
  await renderResponsesStream(res, asyncEvents([
    createRunStarted({ requestId, responseId, model: 'deepseek-v4-flash', protocol: 'responses' }),
    createToolCallDone({ requestId, responseId, messageId, toolCallId: 'call_late', index: 0, name: 'Read', arguments: '{}' }),
    createRunCompleted({ requestId, responseId, finishReason: 'tool_calls' }),
  ]), { model: 'deepseek-v4-flash' });
  const payloads = res.chunks.join('').split('\n').filter(line => line.startsWith('data: ')).map(line => JSON.parse(line.slice(6)));
  assert(payloads.some(p => p.type === 'response.output_item.added' && p.item?.id === 'call_late'));
  const completed = payloads.find(p => p.type === 'response.completed');
  assert.equal(completed.response.output[0].id, 'call_late');
});
