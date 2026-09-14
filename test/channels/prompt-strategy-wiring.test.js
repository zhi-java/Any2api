import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { collectInternalEvents } from '../../src/core/internal-events.js';
import { createInternalRequest } from '../../src/core/internal-request.js';
import { runParsedStreamChannel } from '../../src/channels/common-internal-runner.js';

const commonRunnerSource = readFileSync(new URL('../../src/channels/common-internal-runner.js', import.meta.url), 'utf8');
const glmRunnerSource = readFileSync(new URL('../../src/channels/glm/runner.js', import.meta.url), 'utf8');
const glmClientSource = readFileSync(new URL('../../src/channels/glm/client.js', import.meta.url), 'utf8');

test('common runner routes active tool parsing and retry through Toolify strategy', () => {
  assert.match(commonRunnerSource, /createPromptPlan/);
  assert.match(commonRunnerSource, /preprocessMessagesForToolify/);
  assert.match(commonRunnerSource, /promptInjectionDisabled\s*\?\s*openAIMessages/);
  assert.match(commonRunnerSource, /promptPlan\.createStreamDetector\(\)/);
  assert.match(commonRunnerSource, /attemptToolParseWithRetry/);
  assert.match(commonRunnerSource, /retryToolRequest/);
  assert.doesNotMatch(commonRunnerSource, /createJsonContentExtractor/);
  assert.doesNotMatch(commonRunnerSource, /extractAssistantResponse/);
  assert.doesNotMatch(commonRunnerSource, /parseToolCallsFromText/);
});

test('GLM runner passes caller-supplied XML tool instructions and retry callbacks', () => {
  assert.match(glmRunnerSource, /convertMessages\(messages, \{ toolInstructions \}\)/);
  for (const source of [glmRunnerSource]) {
    assert.match(source, /retryToolRequest/);
    assert.match(source, /currentContent/);
    assert.match(source, /collectParsedStreamContent/);
  }
});

test('channel prompt builders no longer generate old tool instructions internally', () => {
  for (const source of [glmClientSource]) {
    assert.doesNotMatch(source, /buildToolInstructions/);
    assert.match(source, /toolInstructions/);
    assert.doesNotMatch(source, /必须在 assistant_response 中反馈/);
  }
});

test('common runner recovers plan-only tool intent by retrying for XML calls', async () => {
  const request = createInternalRequest({
    protocol: 'chat',
    model: 'glm-test',
    messages: [{ role: 'user', content: '分析项目' }],
    tools: [{ name: 'Read', parameters: { type: 'object', properties: { file_path: { type: 'string' } }, required: ['file_path'] } }],
  });
  let retryPrompt = '';
  let capturedTrigger = '';

  const events = await collectInternalEvents(runParsedStreamChannel(request, {}, {
    channelName: 'Test',
    responseModel: 'glm-test',
    async startStream({ triggerSignal }) {
      capturedTrigger = triggerSignal;
      return {
        streamBody: {},
        retryToolRequest: async ({ retryPrompt: prompt }) => {
          retryPrompt = prompt;
          return `${triggerSignal}\n<function_calls><function_call><tool>Read</tool><args_json><![CDATA[{"file_path":"D:\\\\tools\\\\Any2api\\\\README.md"}]]></args_json></function_call></function_calls>`;
        },
      };
    },
    async *parseStream() {
      yield { type: 'content', content: '好的，我先读取项目的关键文档和目录结构，来为你整理一份分析报告。' };
      yield { type: 'done' };
    },
  }));

  assert.match(retryPrompt, /没有输出任何可执行的工具调用结构/);
  assert.match(retryPrompt, new RegExp(capturedTrigger.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  const done = events.find(event => event.type === 'tool_call.done');
  assert.equal(done.name, 'Read');
  assert.equal(JSON.parse(done.arguments).file_path, 'D:\\tools\\Any2api\\README.md');
  assert.equal(events.find(event => event.type === 'run.completed').finishReason, 'tool_calls');
});

test('common runner emits native provider tool_calls events and cancels upstream', async () => {
  const request = createInternalRequest({
    protocol: 'chat',
    model: 'glm-test',
    messages: [{ role: 'user', content: 'call a tool' }],
    tools: [{ name: 'Read', parameters: { type: 'object', properties: {} } }],
  });
  let cancelled = false;
  const streamBody = { cancel: async () => { cancelled = true; } };

  const events = await collectInternalEvents(runParsedStreamChannel(request, {}, {
    channelName: 'Test',
    responseModel: 'glm-test',
    async startStream() { return { streamBody }; },
    async *parseStream() {
      yield {
        type: 'tool_calls',
        toolCalls: [{ id: 'call_native', type: 'function', function: { name: 'Read', arguments: { file_path: '/tmp/a' } } }],
      };
      yield { type: 'content', content: 'should not stream' };
    },
  }));

  assert.equal(cancelled, true);
  assert.equal(events.some(event => event.type === 'content.text.delta'), false);
  const done = events.find(event => event.type === 'tool_call.done');
  assert.equal(done.name, 'Read');
  assert.equal(done.arguments, '{"file_path":"/tmp/a"}');
  assert.equal(events.find(event => event.type === 'run.completed').finishReason, 'tool_calls');
});

test('common runner streams reasoning deltas before message.started', async () => {
  const request = createInternalRequest({
    protocol: 'responses',
    model: 'glm-test',
    messages: [{ role: 'user', content: 'think then answer' }],
  });

  const events = await collectInternalEvents(runParsedStreamChannel(request, {}, {
    channelName: 'Test',
    responseModel: 'glm-test',
    async startStream() { return { streamBody: {} }; },
    async *parseStream() {
      yield { type: 'thinking', content: '思考第一段。' };
      yield { type: 'thinking', content: '思考第二段。' };
      yield { type: 'content', content: '正文回答' };
      yield { type: 'done' };
    },
  }));

  const types = events.map(event => event.type);
  const firstReasoning = types.indexOf('reasoning.delta');
  const messageStarted = types.indexOf('message.started');
  const firstText = types.indexOf('content.text.delta');
  assert.ok(firstReasoning >= 0, 'reasoning.delta should be emitted');
  assert.ok(messageStarted > firstReasoning, 'message.started must come after reasoning starts');
  assert.ok(firstText > messageStarted, 'text delta must come after message.started');
  const reasoningDeltas = events.filter(event => event.type === 'reasoning.delta');
  assert.equal(reasoningDeltas.length, 2, 'reasoning must stream as multiple deltas, not one block');
  const reasoningDone = types.indexOf('reasoning.done');
  assert.ok(reasoningDone > firstReasoning && reasoningDone < types.indexOf('run.completed'));
});

test('common runner does not fabricate end-of-stream reasoning for tool calls', async () => {
  const request = createInternalRequest({
    protocol: 'responses',
    model: 'glm-test',
    messages: [{ role: 'user', content: 'do work' }],
    tools: [{ name: 'Read', parameters: { type: 'object', properties: { file_path: { type: 'string' } }, required: ['file_path'] } }],
  });

  const events = await collectInternalEvents(runParsedStreamChannel(request, {}, {
    channelName: 'Test',
    responseModel: 'glm-test',
    async startStream({ triggerSignal }) {
      return {
        streamBody: {},
        triggerSignalForTest: triggerSignal,
      };
    },
    async *parseStream() {
      yield {
        type: 'tool_calls',
        toolCalls: [{ id: 'call_fb', type: 'function', function: { name: 'Read', arguments: { file_path: '/tmp/a' } } }],
      };
    },
  }));

  const reasoningDone = events.find(event => event.type === 'reasoning.done');
  const textDone = events.find(event => event.type === 'content.text.done');
  const toolDone = events.find(event => event.type === 'tool_call.done');
  assert.ok(toolDone, 'tool call should be emitted');
  // 无前置文本时不应有 fallback reasoning，也不应有空的 text.done
  assert.equal(reasoningDone, undefined);
  assert.equal(textDone, undefined);
  assert.equal(events.find(event => event.type === 'run.completed').finishReason, 'tool_calls');
});

test('common runner keeps pre-tool text as streamed message text, never end-of-stream reasoning', async () => {
  const request = createInternalRequest({
    protocol: 'responses',
    model: 'glm-test',
    messages: [{ role: 'user', content: 'do work' }],
    tools: [{ name: 'Read', parameters: { type: 'object', properties: { file_path: { type: 'string' } }, required: ['file_path'] } }],
  });

  const events = await collectInternalEvents(runParsedStreamChannel(request, {}, {
    channelName: 'Test',
    responseModel: 'glm-test',
    async startStream() { return { streamBody: {} }; },
    async *parseStream() {
      yield { type: 'content', content: '我先看一下项目结构。' };
      yield {
        type: 'tool_calls',
        toolCalls: [{ id: 'call_pre', type: 'function', function: { name: 'Read', arguments: { file_path: '/tmp/a' } } }],
      };
    },
  }));

  const types = events.map(event => event.type);
  // 说明文本必须在流中途就以 text delta 发出，且先于 tool_call
  const firstText = types.indexOf('content.text.delta');
  const toolDone = types.indexOf('tool_call.done');
  assert.ok(firstText >= 0 && firstText < toolDone, 'pre-tool text must stream before tool call');
  // 不得在末尾把它整段回填成 reasoning
  assert.equal(events.find(event => event.type === 'reasoning.delta'), undefined);
  assert.equal(events.find(event => event.type === 'reasoning.done'), undefined);
  const textDone = events.find(event => event.type === 'content.text.done');
  assert.equal(textDone.text, '我先看一下项目结构。');
  assert.equal(events.find(event => event.type === 'run.completed').finishReason, 'tool_calls');
});

