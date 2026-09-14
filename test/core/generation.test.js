import test from 'node:test';
import assert from 'node:assert/strict';

import { generateInternalEvents, isChannelRunnerAvailable, prepareInternalGeneration } from '../../src/core/generation.js';
import { createInternalRequest } from '../../src/core/internal-request.js';

async function collect(iterable) {
  const out = [];
  for await (const item of iterable) out.push(item);
  return out;
}

test('generation core has runners for the supported channels only', () => {
  assert.equal(isChannelRunnerAvailable('deepseek'), true);
  assert.equal(isChannelRunnerAvailable('glm'), true);
  assert.equal(isChannelRunnerAvailable('qwen'), false);
  assert.equal(isChannelRunnerAvailable('kimi'), false);
});

test('generation core surfaces supported channel upstream result or error events', async () => {
  const request = createInternalRequest({
    protocol: 'responses',
    model: 'glm-5.2',
    stream: false,
    messages: [{ role: 'user', content: 'hello' }],
  });
  const events = await collect(generateInternalEvents(request, {}));
  const failed = events.find(event => event.type === 'run.failed');
  if (failed) {
    assert.match(failed.error.message, /GLM|credentials|token|error/i);
  } else {
    assert.ok(events.some(event => event.type === 'run.started'));
    assert.ok(events.some(event => event.type === 'run.completed'));
  }
});

test('prepareInternalGeneration resolves the GLM runner before streaming', () => {
  const request = createInternalRequest({
    protocol: 'responses',
    model: 'glm-5.2',
    stream: true,
    messages: [{ role: 'user', content: 'hello' }],
  });
  const prepared = prepareInternalGeneration(request);
  assert.equal(prepared.resolvedRequest.model.channel, 'glm');
  assert.equal(typeof prepared.runner, 'function');
});

test('prepareInternalGeneration rejects removed channels before streaming', () => {
  const request = createInternalRequest({
    protocol: 'responses',
    model: 'qwen3.7-plus',
    stream: true,
    messages: [{ role: 'user', content: 'hello' }],
  });
  assert.throws(() => prepareInternalGeneration(request), /未知模型|Unknown model|Unsupported model/);
});

test('prepareInternalGeneration still rejects unknown models before streaming', () => {
  const request = createInternalRequest({
    protocol: 'responses',
    model: 'not-a-real-model',
    stream: true,
    messages: [{ role: 'user', content: 'hello' }],
  });
  assert.throws(() => prepareInternalGeneration(request), /未知模型|Unknown model|Unsupported model/);
});
