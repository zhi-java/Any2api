import test from 'node:test';
import assert from 'node:assert/strict';

import { renderClaudeMessagesJSON, renderClaudeMessagesStream } from '../../src/protocols/claude-messages/renderer.js';
import {
  createMessageStarted,
  createReasoningDelta,
  createRunCompleted,
  createRunStarted,
  createTextDelta,
  createToolCallArgumentsDelta,
  createToolCallDone,
  createToolCallStarted,
} from '../../src/core/internal-events.js';

async function* asyncEvents(items) {
  for (const item of items) yield item;
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

function jsonRes() {
  return {
    statusCode: 200,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
  };
}

test('Claude renderer emits message and content block lifecycle', async () => {
  const requestId = 'req_claude';
  const responseId = 'resp_claude';
  const messageId = 'msg_claude';
  const res = streamRes();
  await renderClaudeMessagesStream(res, asyncEvents([
    createRunStarted({ requestId, responseId, model: 'deepseek-flash', protocol: 'claude_messages' }),
    createMessageStarted({ requestId, responseId, messageId }),
    createTextDelta({ requestId, responseId, messageId, delta: 'hello' }),
    createRunCompleted({ requestId, responseId, finishReason: 'stop', usage: { outputTokens: 2 } }),
  ]), { model: 'deepseek-flash' });
  const wire = res.chunks.join('');
  assert.match(wire, /event: message_start/);
  assert.match(wire, /event: content_block_start/);
  assert.match(wire, /event: content_block_delta/);
  assert.match(wire, /"text":"hello"/);
  assert.match(wire, /event: content_block_stop/);
  assert.match(wire, /event: message_delta/);
  assert.match(wire, /"stop_reason":"end_turn"/);
  assert.match(wire, /event: message_stop/);
});

test('Claude stream renderer emits upstream reasoning as thinking deltas', async () => {
  const requestId = 'req_claude_thinking_stream';
  const responseId = 'resp_claude_thinking_stream';
  const messageId = 'msg_claude_thinking_stream';
  const res = streamRes();
  await renderClaudeMessagesStream(res, asyncEvents([
    createRunStarted({ requestId, responseId, model: 'deepseek-flash', protocol: 'claude_messages' }),
    createMessageStarted({ requestId, responseId, messageId }),
    createReasoningDelta({ requestId, responseId, messageId, delta: '先分析需求。' }),
    createTextDelta({ requestId, responseId, messageId, delta: '最终回答。' }),
    createRunCompleted({ requestId, responseId, finishReason: 'stop', usage: { outputTokens: 2 } }),
  ]), { model: 'deepseek-flash' });
  const wire = res.chunks.join('');
  assert.match(wire, /"content_block":\{"type":"thinking","thinking":""\}/);
  assert.match(wire, /"delta":\{"type":"thinking_delta","thinking":"先分析需求。"\}/);
  assert.match(wire, /"content_block":\{"type":"text","text":""\}/);
  assert.ok(wire.indexOf('thinking_delta') < wire.indexOf('text_delta'));
});

test('Claude JSON renderer aggregates Internal Events into message object', async () => {
  const requestId = 'req_claude_json';
  const responseId = 'resp_claude_json';
  const messageId = 'msg_claude_json';
  const res = jsonRes();
  await renderClaudeMessagesJSON(res, asyncEvents([
    createRunStarted({ requestId, responseId, model: 'deepseek-flash', protocol: 'claude_messages' }),
    createMessageStarted({ requestId, responseId, messageId }),
    createTextDelta({ requestId, responseId, messageId, delta: 'hello' }),
    createRunCompleted({ requestId, responseId, finishReason: 'stop', usage: { inputTokens: 1, outputTokens: 2 } }),
  ]), { model: 'deepseek-flash' });
  assert.equal(res.body.type, 'message');
  assert.equal(res.body.role, 'assistant');
  assert.equal(res.body.content[0].type, 'text');
  assert.equal(res.body.content[0].text, 'hello');
  assert.equal(res.body.stop_reason, 'end_turn');
  assert.equal(res.body.usage.input_tokens, 1);
  assert.equal(res.body.usage.output_tokens, 2);
});

test('Claude JSON renderer emits upstream reasoning as thinking block before text', async () => {
  const requestId = 'req_claude_thinking_json';
  const responseId = 'resp_claude_thinking_json';
  const messageId = 'msg_claude_thinking_json';
  const res = jsonRes();
  await renderClaudeMessagesJSON(res, asyncEvents([
    createRunStarted({ requestId, responseId, model: 'deepseek-flash', protocol: 'claude_messages' }),
    createMessageStarted({ requestId, responseId, messageId }),
    createReasoningDelta({ requestId, responseId, messageId, delta: '先分析需求。' }),
    createTextDelta({ requestId, responseId, messageId, delta: '最终回答。' }),
    createRunCompleted({ requestId, responseId, finishReason: 'stop', usage: { inputTokens: 1, outputTokens: 2, reasoningTokens: 3 } }),
  ]), { model: 'deepseek-flash' });
  assert.equal(res.body.content[0].type, 'thinking');
  assert.equal(res.body.content[0].thinking, '先分析需求。');
  assert.equal(res.body.content[1].type, 'text');
  assert.equal(res.body.content[1].text, '最终回答。');
});

test('Claude JSON renderer preserves text block before tool_use block', async () => {
  const requestId = 'req_claude_tool_text';
  const responseId = 'resp_claude_tool_text';
  const messageId = 'msg_claude_tool_text';
  const toolCallId = 'call_patch';
  const res = jsonRes();
  await renderClaudeMessagesJSON(res, asyncEvents([
    createRunStarted({ requestId, responseId, model: 'deepseek-flash', protocol: 'claude_messages' }),
    createMessageStarted({ requestId, responseId, messageId }),
    createTextDelta({ requestId, responseId, messageId, delta: '以下是修改摘要。' }),
    createToolCallStarted({ requestId, responseId, messageId, toolCallId, index: 0, name: 'ApplyPatch' }),
    createToolCallArgumentsDelta({ requestId, responseId, messageId, toolCallId, index: 0, delta: '{"patch":"*** Begin Patch"}' }),
    createToolCallDone({ requestId, responseId, messageId, toolCallId, index: 0, name: 'ApplyPatch', arguments: '{"patch":"*** Begin Patch"}' }),
    createRunCompleted({ requestId, responseId, finishReason: 'tool_calls' }),
  ]), { model: 'deepseek-flash' });
  assert.equal(res.body.content[0].type, 'text');
  assert.equal(res.body.content[0].text, '以下是修改摘要。');
  assert.equal(res.body.content[1].type, 'tool_use');
  assert.equal(res.body.content[1].name, 'ApplyPatch');
  assert.equal(res.body.stop_reason, 'tool_use');
});
