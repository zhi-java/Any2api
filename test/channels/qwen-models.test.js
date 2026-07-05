import test from 'node:test';
import assert from 'node:assert/strict';

import { QWEN_MODEL_MAP, listQwenModels, resolveModel } from '../../src/channels/qwen/models.js';
import { qwenRuntimeOptionsForRequest } from '../../src/channels/qwen/runner.js';

test('Qwen exposes only qwen3.7-plus and qwen3.7-max as routable models', () => {
  assert.deepEqual(Object.keys(QWEN_MODEL_MAP).sort(), ['qwen3.7-max', 'qwen3.7-plus']);
  assert.deepEqual(listQwenModels().map(model => model.id).sort(), ['qwen3.7-max', 'qwen3.7-plus']);
});

test('Qwen mode suffix variants are rejected', () => {
  for (const model of [
    'qwen3.7-plus-search',
    'qwen3.7-plus-deep-research',
    'qwen3.7-plus-thinking',
    'qwen3.7-max-search',
    'qwen3.7-max-deep-research',
    'qwen3.6-plus',
  ]) {
    assert.throws(() => resolveModel(model), /Unknown model/);
  }
});

test('Qwen base models resolve to stable t2t chat mode', () => {
  for (const model of ['qwen3.7-plus', 'qwen3.7-max']) {
    const resolved = resolveModel(model);
    assert.equal(resolved.baseModel, model);
    assert.equal(resolved.chatMode, 't2t');
    assert.equal(resolved.forceThinking, false);
  }
});

test('Qwen tool requests force stable runtime options for Toolify calls', () => {
  const modelConfig = resolveModel('qwen3.7-plus');
  assert.deepEqual(qwenRuntimeOptionsForRequest(modelConfig, {
    enable_search: true,
    enable_thinking: true,
  }, true), {
    chatMode: 't2t',
    thinkingEnabled: false,
    searchEnabled: false,
  });
});

test('Qwen non-tool requests keep t2t mode and do not enable search variants', () => {
  const modelConfig = resolveModel('qwen3.7-plus');
  assert.deepEqual(qwenRuntimeOptionsForRequest(modelConfig, {
    enable_search: true,
    enable_thinking: true,
  }, false), {
    chatMode: 't2t',
    thinkingEnabled: true,
    searchEnabled: false,
  });
});
