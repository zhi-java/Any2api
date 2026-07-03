import test from 'node:test';
import assert from 'node:assert/strict';

import { DEEPSEEK_MODEL_MAP } from '../src/channels/deepseek/models.js';
import { GLM_MODEL_MAP } from '../src/channels/glm/models.js';
import { KIMI_MODEL_MAP, listKimiModels } from '../src/channels/kimi/models.js';
import { QWEN_BASE_MODELS, QWEN_MODEL_MAP, listQwenModels, listQwenRoutableModels } from '../src/channels/qwen/models.js';
import { routeModel } from '../src/utils/model-router.js';

test('DeepSeek public model map exposes only v4 model names', () => {
  assert.deepEqual(Object.keys(DEEPSEEK_MODEL_MAP), ['deepseek-v4-flash', 'deepseek-v4-pro']);
});

test('routeModel rejects retired deepseek 4v typo model name', () => {
  assert.throws(() => routeModel('deepseek-4v-pro'), /未知模型: deepseek-4v-pro/);
});

test('routeModel accepts the single public GLM model', () => {
  assert.deepEqual(routeModel('glm-5.2'), { channel: 'glm', model: 'glm-5.2' });
});

test('GLM public model map exposes only glm-5.2', () => {
  assert.deepEqual(Object.keys(GLM_MODEL_MAP), ['glm-5.2']);
});

test('routeModel normalizes client suffixes before matching glm-5.2', () => {
  assert.deepEqual(routeModel('glm-5.2 [1m]'), { channel: 'glm', model: 'glm-5.2' });
});

test('routeModel accepts Qwen public models and variants', () => {
  assert.deepEqual(routeModel('qwen3.7-plus'), { channel: 'qwen', model: 'qwen3.7-plus' });
  assert.deepEqual(routeModel('qwen3.7-plus-thinking'), { channel: 'qwen', model: 'qwen3.7-plus-thinking' });
  assert.deepEqual(routeModel('qwen3.7-plus-deep-research'), { channel: 'qwen', model: 'qwen3.7-plus-deep-research' });
  assert.deepEqual(routeModel('qwen3.7-plus-image-edit'), { channel: 'qwen', model: 'qwen3.7-plus-image-edit' });
});

test('Qwen public model map exposes the local page model snapshot', () => {
  assert.equal(QWEN_BASE_MODELS.length, 3);
  assert.ok(Object.prototype.hasOwnProperty.call(QWEN_MODEL_MAP, 'qwen3.7-plus'));
  assert.ok(Object.prototype.hasOwnProperty.call(QWEN_MODEL_MAP, 'qwen3.7-max'));
  assert.ok(Object.prototype.hasOwnProperty.call(QWEN_MODEL_MAP, 'qwen3.6-plus'));
  assert.ok(Object.prototype.hasOwnProperty.call(QWEN_MODEL_MAP, 'qwen3.7-plus-deep-research'));
  assert.ok(Object.prototype.hasOwnProperty.call(QWEN_MODEL_MAP, 'qwen3.7-max-image'));
  assert.ok(Object.prototype.hasOwnProperty.call(QWEN_MODEL_MAP, 'qwen3.6-plus-webdev'));
  assert.equal(Object.prototype.hasOwnProperty.call(QWEN_MODEL_MAP, 'qwen3.5-flash'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(QWEN_MODEL_MAP, 'qwen-max'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(QWEN_MODEL_MAP, 'qwen-turbo'), false);
});

test('Qwen public model list exposes only the three base models', () => {
  const models = listQwenModels();
  assert.deepEqual(models.map(model => model.id), ['qwen3.7-plus', 'qwen3.7-max', 'qwen3.6-plus']);
  const qwen37 = models.find(model => model.id === 'qwen3.7-plus');
  assert.equal(qwen37.name, 'Qwen3.7-Plus');
  assert.equal(qwen37.owned_by, 'qwen');
  assert.equal(qwen37.capabilities.thinking, true);
  assert.ok(qwen37.chat_types.includes('deep_research'));
  assert.equal(models.some(model => model.id.endsWith('-thinking')), false);
  assert.equal(models.some(model => model.id.endsWith('-deep-research')), false);
});

test('Qwen routable model list keeps derived modes available internally', () => {
  const models = listQwenRoutableModels();
  assert.ok(models.some(model => model.id === 'qwen3.7-plus-thinking'));
  assert.ok(models.some(model => model.id === 'qwen3.7-plus-deep-research'));
  assert.ok(models.some(model => model.id === 'qwen3.7-plus-image-edit'));
});

test('routeModel normalizes client suffixes before matching Qwen models', () => {
  assert.deepEqual(routeModel('qwen3.7-plus [1m]'), { channel: 'qwen', model: 'qwen3.7-plus' });
});

test('routeModel accepts Kimi public models', () => {
  assert.deepEqual(routeModel('kimi-k2.6'), { channel: 'kimi', model: 'kimi-k2.6' });
  assert.deepEqual(routeModel('kimi-k2.6-thinking'), { channel: 'kimi', model: 'kimi-k2.6-thinking' });
});

test('Kimi public model map exposes k2.6 variants', () => {
  assert.deepEqual(Object.keys(KIMI_MODEL_MAP), ['kimi-k2.6', 'kimi-k2.6-thinking']);
});

test('Kimi public model list includes base and thinking variants', () => {
  const models = listKimiModels();
  assert.deepEqual(models.map(model => model.id), ['kimi-k2.6', 'kimi-k2.6-thinking']);
  assert.equal(models[0].owned_by, 'kimi');
  assert.equal(models[0].capabilities.search, true);
  assert.equal(models[1].capabilities.thinking, true);
});

test('routeModel normalizes client suffixes before matching Kimi models', () => {
  assert.deepEqual(routeModel('kimi-k2.6 [1m]'), { channel: 'kimi', model: 'kimi-k2.6' });
});

test('routeModel rejects retired GLM flash and pro model names', () => {
  assert.throws(() => routeModel('glm-5.2-flash'), /未知模型: glm-5\.2-flash/);
  assert.throws(() => routeModel('glm-5.2-pro'), /未知模型: glm-5\.2-pro/);
});

test('routeModel unknown model message advertises glm-5.2 only for GLM', () => {
  assert.throws(
    () => routeModel('unknown-model'),
    /glm-5\.2/
  );
  assert.throws(
    () => routeModel('unknown-model'),
    /qwen3\.7-plus/
  );
  assert.throws(
    () => routeModel('unknown-model'),
    /kimi-k2\.6/
  );
  assert.throws(
    () => routeModel('unknown-model'),
    (err) => !String(err.message).includes('glm-5.2-flash')
      && !String(err.message).includes('glm-5.2-pro')
      && !String(err.message).includes('deepseek-4v-pro')
  );
});
