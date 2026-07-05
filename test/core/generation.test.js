import test from 'node:test';
import assert from 'node:assert/strict';

import { generateInternalEvents, isChannelRunnerAvailable, prepareInternalGeneration } from '../../src/core/generation.js';
import { createInternalRequest } from '../../src/core/internal-request.js';

async function collect(iterable) {
  const out = [];
  for await (const item of iterable) out.push(item);
  return out;
}

test('generation core has runners for all migrated channels', () => {
  assert.equal(isChannelRunnerAvailable('deepseek'), true);
  assert.equal(isChannelRunnerAvailable('glm'), true);
  assert.equal(isChannelRunnerAvailable('qwen'), true);
  assert.equal(isChannelRunnerAvailable('kimi'), true);
});

test('generation core surfaces migrated channel upstream result or error events', async () => {
  const request = createInternalRequest({
    protocol: 'responses',
    model: 'qwen3.7-plus',
    stream: false,
    messages: [{ role: 'user', content: 'hello' }],
  });
  const events = await collect(generateInternalEvents(request, {}));
  const failed = events.find(event => event.type === 'run.failed');
  if (failed) {
    assert.match(failed.error.message, /Qwen|credentials|token/i);
  } else {
    assert.ok(events.some(event => event.type === 'run.started'));
    assert.ok(events.some(event => event.type === 'run.completed'));
  }
});

test('prepareInternalGeneration resolves migrated Qwen runner before streaming', () => {
  const request = createInternalRequest({
    protocol: 'responses',
    model: 'qwen3.7-plus',
    stream: true,
    messages: [{ role: 'user', content: 'hello' }],
  });
  const prepared = prepareInternalGeneration(request);
  assert.equal(prepared.resolvedRequest.model.channel, 'qwen');
  assert.equal(typeof prepared.runner, 'function');
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
