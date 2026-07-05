import test from 'node:test';
import assert from 'node:assert/strict';

import { convertMessages } from '../../src/channels/glm/client.js';
import { glmChatModeForRequest, glmRuntimeOptionsForRequest, isGlmSearchEnabled } from '../../src/channels/glm/runner.js';

test('GLM single-turn prompt is sent without synthetic transcript control tags', () => {
  const messages = convertMessages([{ role: 'user', content: '请只回答 GLM_OK' }]);
  assert.equal(messages.length, 1);
  assert.equal(messages[0].role, 'user');
  assert.equal(messages[0].content[0].text, '请只回答 GLM_OK');
  assert.doesNotMatch(messages[0].content[0].text, /<\|user\|>|<\|assistant\|>/);
});

test('GLM defaults Web search and deep-research chat mode off for normal API calls', () => {
  const modelConfig = { chatMode: 'deep_research', search: true };
  assert.equal(isGlmSearchEnabled({}), false);
  assert.equal(glmChatModeForRequest(modelConfig, false), '');
});

test('GLM enables deep-research chat mode only when the request opts into search', () => {
  const modelConfig = { chatMode: 'deep_research', search: true };
  assert.equal(isGlmSearchEnabled({ search_enabled: true }), true);
  assert.equal(isGlmSearchEnabled({ enable_search: true }), true);
  assert.equal(glmChatModeForRequest(modelConfig, true), 'deep_research');
});

test('GLM tool requests force stable runtime options for Toolify calls', () => {
  const modelConfig = { chatMode: 'deep_research', plusModel: true };
  assert.deepEqual(glmRuntimeOptionsForRequest(modelConfig, {
    enable_search: true,
    search_enabled: true,
  }, true), {
    plusModel: false,
    searchEnabled: false,
    chatMode: '',
  });
});

test('GLM multi-turn prompt still preserves roles in a flattened transcript', () => {
  const messages = convertMessages([
    { role: 'user', content: '第一轮' },
    { role: 'assistant', content: '回复' },
    { role: 'user', content: '第二轮' },
  ]);
  assert.equal(messages.length, 1);
  assert.match(messages[0].content[0].text, /<\|user\|>\n第一轮/);
  assert.match(messages[0].content[0].text, /<\|assistant\|>\n回复/);
  assert.match(messages[0].content[0].text, /<\|user\|>\n第二轮/);
});
