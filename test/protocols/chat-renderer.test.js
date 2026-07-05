import test from 'node:test';
import assert from 'node:assert/strict';

import { renderChatCompletionsJSON, renderChatCompletionsStream } from '../../src/protocols/chat-completions/renderer.js';
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

test('Chat renderer emits role, content delta, finish chunk, and DONE', async () => {
  const requestId = 'req_chat';
  const responseId = 'resp_chat';
  const messageId = 'msg_chat';
  const res = streamRes();
  await renderChatCompletionsStream(res, asyncEvents([
    createRunStarted({ requestId, responseId, model: 'deepseek-v4-flash', protocol: 'chat_completions', created: 123 }),
    createMessageStarted({ requestId, responseId, messageId }),
    createTextDelta({ requestId, responseId, messageId, delta: 'hello' }),
    createRunCompleted({ requestId, responseId, finishReason: 'stop' }),
  ]), { model: 'deepseek-v4-flash' });
  const wire = res.chunks.join('');
  assert.match(wire, /chat\.completion\.chunk/);
  assert.match(wire, /"role":"assistant"/);
  assert.match(wire, /"content":"hello"/);
  assert.match(wire, /"finish_reason":"stop"/);
  assert.match(wire, /data: \[DONE\]/);
});

test('Chat JSON renderer aggregates Internal Events into chat.completion', async () => {
  const requestId = 'req_chat_json';
  const responseId = 'resp_chat_json';
  const messageId = 'msg_chat_json';
  const res = jsonRes();
  await renderChatCompletionsJSON(res, asyncEvents([
    createRunStarted({ requestId, responseId, model: 'deepseek-v4-flash', protocol: 'chat_completions', created: 123 }),
    createMessageStarted({ requestId, responseId, messageId }),
    createTextDelta({ requestId, responseId, messageId, delta: 'hello' }),
    createRunCompleted({ requestId, responseId, finishReason: 'stop', usage: { inputTokens: 1, outputTokens: 2 } }),
  ]), { model: 'deepseek-v4-flash' });
  assert.equal(res.body.object, 'chat.completion');
  assert.equal(res.body.choices[0].message.role, 'assistant');
  assert.equal(res.body.choices[0].message.content, 'hello');
  assert.equal(res.body.choices[0].finish_reason, 'stop');
  assert.equal(res.body.usage.prompt_tokens, 1);
  assert.equal(res.body.usage.completion_tokens, 2);
});
