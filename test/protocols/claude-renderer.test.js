import test from 'node:test';
import assert from 'node:assert/strict';

import { renderClaudeMessagesJSON, renderClaudeMessagesStream } from '../../src/protocols/claude-messages/renderer.js';
import {
  createMessageStarted,
  createRunCompleted,
  createRunStarted,
  createTextDelta,
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
    createRunStarted({ requestId, responseId, model: 'deepseek-v4-flash', protocol: 'claude_messages' }),
    createMessageStarted({ requestId, responseId, messageId }),
    createTextDelta({ requestId, responseId, messageId, delta: 'hello' }),
    createRunCompleted({ requestId, responseId, finishReason: 'stop', usage: { outputTokens: 2 } }),
  ]), { model: 'deepseek-v4-flash' });
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

test('Claude JSON renderer aggregates Internal Events into message object', async () => {
  const requestId = 'req_claude_json';
  const responseId = 'resp_claude_json';
  const messageId = 'msg_claude_json';
  const res = jsonRes();
  await renderClaudeMessagesJSON(res, asyncEvents([
    createRunStarted({ requestId, responseId, model: 'deepseek-v4-flash', protocol: 'claude_messages' }),
    createMessageStarted({ requestId, responseId, messageId }),
    createTextDelta({ requestId, responseId, messageId, delta: 'hello' }),
    createRunCompleted({ requestId, responseId, finishReason: 'stop', usage: { inputTokens: 1, outputTokens: 2 } }),
  ]), { model: 'deepseek-v4-flash' });
  assert.equal(res.body.type, 'message');
  assert.equal(res.body.role, 'assistant');
  assert.equal(res.body.content[0].type, 'text');
  assert.equal(res.body.content[0].text, 'hello');
  assert.equal(res.body.stop_reason, 'end_turn');
  assert.equal(res.body.usage.input_tokens, 1);
  assert.equal(res.body.usage.output_tokens, 2);
});
