import test from 'node:test';
import assert from 'node:assert/strict';

import { getRecentToolCallIndex, getResponseToolCallIndex } from '../../src/services/conversation.js';
import { renderChatCompletionsJSON, renderChatCompletionsStream } from '../../src/protocols/chat-completions/renderer.js';
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

test('Chat renderer emits role, content delta, finish chunk, and DONE', async () => {
  const requestId = 'req_chat';
  const responseId = 'resp_chat';
  const messageId = 'msg_chat';
  const res = streamRes();
  await renderChatCompletionsStream(res, asyncEvents([
    createRunStarted({ requestId, responseId, model: 'deepseek-flash', protocol: 'chat_completions', created: 123 }),
    createMessageStarted({ requestId, responseId, messageId }),
    createTextDelta({ requestId, responseId, messageId, delta: 'hello' }),
    createRunCompleted({ requestId, responseId, finishReason: 'stop' }),
  ]), { model: 'deepseek-flash' });
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
    createRunStarted({ requestId, responseId, model: 'deepseek-flash', protocol: 'chat_completions', created: 123 }),
    createMessageStarted({ requestId, responseId, messageId }),
    createTextDelta({ requestId, responseId, messageId, delta: 'hello' }),
    createRunCompleted({ requestId, responseId, finishReason: 'stop', usage: { inputTokens: 1, outputTokens: 2 } }),
  ]), { model: 'deepseek-flash' });
  assert.equal(res.body.object, 'chat.completion');
  assert.equal(res.body.choices[0].message.role, 'assistant');
  assert.equal(res.body.choices[0].message.content, 'hello');
  assert.equal(res.body.choices[0].finish_reason, 'stop');
  assert.equal(res.body.usage.prompt_tokens, 1);
  assert.equal(res.body.usage.completion_tokens, 2);
});

test('Chat JSON renderer preserves assistant content and reasoning alongside tool_calls', async () => {
  const requestId = 'req_chat_tool_text';
  const responseId = 'resp_chat_tool_text';
  const messageId = 'msg_chat_tool_text';
  const toolCallId = 'call_patch';
  const res = jsonRes();
  await renderChatCompletionsJSON(res, asyncEvents([
    createRunStarted({ requestId, responseId, model: 'deepseek-flash', protocol: 'chat_completions', created: 123 }),
    createMessageStarted({ requestId, responseId, messageId }),
    createTextDelta({ requestId, responseId, messageId, delta: '以下是修改摘要。' }),
    createReasoningDelta({ requestId, responseId, messageId, delta: '以下是修改摘要。' }),
    createToolCallStarted({ requestId, responseId, messageId, toolCallId, index: 0, name: 'ApplyPatch' }),
    createToolCallArgumentsDelta({ requestId, responseId, messageId, toolCallId, index: 0, delta: '{"patch":"*** Begin Patch"}' }),
    createToolCallDone({ requestId, responseId, messageId, toolCallId, index: 0, name: 'ApplyPatch', arguments: '{"patch":"*** Begin Patch"}' }),
    createRunCompleted({ requestId, responseId, finishReason: 'tool_calls' }),
  ]), { model: 'deepseek-flash' });
  const message = res.body.choices[0].message;
  assert.equal(message.content, '以下是修改摘要。');
  assert.equal(message.reasoning_content, '以下是修改摘要。');
  assert.equal(message.tool_calls.length, 1);
  assert.equal(message.tool_calls[0].function.name, 'ApplyPatch');
  assert.equal(res.body.choices[0].finish_reason, 'tool_calls');
});

test('Chat stream renderer emits reasoning_content before tool_calls when present', async () => {
  const requestId = 'req_chat_tool_reasoning_stream';
  const responseId = 'resp_chat_tool_reasoning_stream';
  const messageId = 'msg_chat_tool_reasoning_stream';
  const toolCallId = 'call_patch';
  const res = streamRes();
  await renderChatCompletionsStream(res, asyncEvents([
    createRunStarted({ requestId, responseId, model: 'deepseek-flash', protocol: 'chat_completions', created: 123 }),
    createMessageStarted({ requestId, responseId, messageId }),
    createReasoningDelta({ requestId, responseId, messageId, delta: '准备修改 README。' }),
    createToolCallStarted({ requestId, responseId, messageId, toolCallId, index: 0, name: 'ApplyPatch' }),
    createToolCallDone({ requestId, responseId, messageId, toolCallId, index: 0, name: 'ApplyPatch', arguments: '{"patch":"*** Begin Patch"}' }),
    createRunCompleted({ requestId, responseId, finishReason: 'tool_calls' }),
  ]), { model: 'deepseek-flash' });
  const wire = res.chunks.join('');
  assert.match(wire, /"reasoning_content":"准备修改 README。"/);
  assert.match(wire, /"tool_calls":\[\{"index":0,"id":"call_patch"/);
  assert.ok(wire.indexOf('reasoning_content') < wire.indexOf('tool_calls'));
  assert.match(wire, /"finish_reason":"tool_calls"/);
  assert.deepEqual(getResponseToolCallIndex(responseId).get('call_patch'), { name: 'ApplyPatch', arguments: '{"patch":"*** Begin Patch"}' });
  assert.deepEqual(getRecentToolCallIndex(['call_patch']).get('call_patch'), { name: 'ApplyPatch', arguments: '{"patch":"*** Begin Patch"}' });
});

test('Chat stream records tool call before completion for clients that omit assistant history', async () => {
  const requestId = 'req_chat_tool_early';
  const responseId = 'resp_chat_tool_early';
  const messageId = 'msg_chat_tool_early';
  const toolCallId = 'call_chat_early';
  const res = streamRes();
  async function* interruptedEvents() {
    yield createRunStarted({ requestId, responseId, model: 'deepseek-flash', protocol: 'chat_completions', created: 123 });
    yield createToolCallStarted({ requestId, responseId, messageId, toolCallId, index: 0, name: 'Read' });
    yield createToolCallDone({ requestId, responseId, messageId, toolCallId, index: 0, name: 'Read', arguments: '{"file_path":"README.md"}' });
    assert.deepEqual(getRecentToolCallIndex([toolCallId]).get(toolCallId), { name: 'Read', arguments: '{"file_path":"README.md"}' });
  }
  await renderChatCompletionsStream(res, interruptedEvents(), { model: 'deepseek-flash' });
});

test('Chat 流式响应在结束前输出 usage chunk（客户端据此计算用量与 tok/s）', async () => {
  const requestId = 'req_usage_stream';
  const responseId = 'resp_usage_stream';
  const res = streamRes();
  await renderChatCompletionsStream(res, asyncEvents([
    createRunStarted({ requestId, responseId, model: 'deepseek-flash', protocol: 'chat_completions' }),
    createMessageStarted({ requestId, responseId, messageId: 'msg_u' }),
    createTextDelta({ requestId, responseId, messageId: 'msg_u', delta: '你好' }),
    createRunCompleted({
      requestId, responseId, finishReason: 'stop',
      usage: { inputTokens: 12, outputTokens: 34, reasoningTokens: 5 },
    }),
  ]), { model: 'deepseek-flash' });

  const wire = res.chunks.join('');
  const usageChunks = wire
    .split('\n')
    .filter(line => line.startsWith('data:'))
    .map(line => line.slice(5).trim())
    .filter(d => d && d !== '[DONE]')
    .map(d => { try { return JSON.parse(d); } catch { return null; } })
    .filter(Boolean)
    .filter(j => j.usage);

  assert.equal(usageChunks.length, 1, '流式应恰好输出一个带 usage 的 chunk');
  const usage = usageChunks[0].usage;
  assert.equal(usage.prompt_tokens, 12);
  assert.equal(usage.completion_tokens, 34);
  assert.equal(usage.total_tokens, 46);
  assert.equal(usage.completion_tokens_details.reasoning_tokens, 5);

  // usage chunk 必须出现在 [DONE] 之前，且其 choices 为空数组（OpenAI 规范）
  const usageAt = wire.indexOf('"usage"');
  const doneAt = wire.indexOf('[DONE]');
  assert.ok(usageAt > 0 && usageAt < doneAt, 'usage 必须在 [DONE] 之前');
  assert.deepEqual(usageChunks[0].choices, [], 'usage chunk 的 choices 应为空数组');
});

test('Chat 流式在无 usage 事件时也输出 usage chunk（补零，保证客户端字段存在）', async () => {
  const requestId = 'req_usage_zero';
  const responseId = 'resp_usage_zero';
  const res = streamRes();
  await renderChatCompletionsStream(res, asyncEvents([
    createRunStarted({ requestId, responseId, model: 'deepseek-flash', protocol: 'chat_completions' }),
    createMessageStarted({ requestId, responseId, messageId: 'msg_z' }),
    createTextDelta({ requestId, responseId, messageId: 'msg_z', delta: 'ok' }),
    createRunCompleted({ requestId, responseId, finishReason: 'stop' }),
  ]), { model: 'deepseek-flash' });

  const wire = res.chunks.join('');
  assert.match(wire, /"usage":\{/, '即使无用量也应输出结构完整的 usage 字段');
});
