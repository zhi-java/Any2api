import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { collectInternalEvents } from '../../src/core/internal-events.js';
import { createInternalRequest } from '../../src/core/internal-request.js';
import { runParsedStreamChannel } from '../../src/channels/common-internal-runner.js';

const commonRunnerSource = readFileSync(new URL('../../src/channels/common-internal-runner.js', import.meta.url), 'utf8');
const glmRunnerSource = readFileSync(new URL('../../src/channels/glm/runner.js', import.meta.url), 'utf8');
const kimiRunnerSource = readFileSync(new URL('../../src/channels/kimi/runner.js', import.meta.url), 'utf8');
const qwenRunnerSource = readFileSync(new URL('../../src/channels/qwen/runner.js', import.meta.url), 'utf8');
const glmClientSource = readFileSync(new URL('../../src/channels/glm/client.js', import.meta.url), 'utf8');
const kimiClientSource = readFileSync(new URL('../../src/channels/kimi/client.js', import.meta.url), 'utf8');
const qwenClientSource = readFileSync(new URL('../../src/channels/qwen/client.js', import.meta.url), 'utf8');

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

test('GLM Kimi and Qwen runners pass caller-supplied XML tool instructions and retry callbacks', () => {
  assert.match(glmRunnerSource, /convertMessages\(messages, \{ toolInstructions \}\)/);
  assert.match(kimiRunnerSource, /buildKimiMessages\(messages, \{ toolInstructions \}\)/);
  assert.match(qwenRunnerSource, /buildQwenMessages\(messages, \{ toolInstructions \}\)/);
  for (const source of [glmRunnerSource, kimiRunnerSource, qwenRunnerSource]) {
    assert.match(source, /retryToolRequest/);
    assert.match(source, /currentContent/);
    assert.match(source, /collectParsedStreamContent/);
  }
});

test('channel prompt builders no longer generate old tool instructions internally', () => {
  for (const source of [glmClientSource, kimiClientSource, qwenClientSource]) {
    assert.doesNotMatch(source, /buildToolInstructions/);
    assert.match(source, /toolInstructions/);
    assert.doesNotMatch(source, /必须在 assistant_response 中反馈/);
  }
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
