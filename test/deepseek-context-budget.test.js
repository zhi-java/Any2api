import test from 'node:test';
import assert from 'node:assert/strict';

import {
  DEEPSEEK_FLASH_MODEL,
  DEEPSEEK_FLASH_MODEL_TYPE,
  estimatePromptTokens,
  isContextLimitError,
  selectContextExecutionPlan,
} from '../src/channels/deepseek/context-budget.js';

test('estimatePromptTokens is conservative for English and CJK text', () => {
  assert.equal(estimatePromptTokens(''), 0);
  assert.equal(estimatePromptTokens('a'.repeat(400)), 100);
  assert.equal(estimatePromptTokens('你'.repeat(30)), 30);
});

test('selectContextExecutionPlan falls back from pro to flash when estimated prompt exceeds safe budget', () => {
  const plan = selectContextExecutionPlan({
    requestedModel: 'deepseek-v4-pro',
    requestedModelType: 'expert',
    promptForBudget: 'a'.repeat(404),
    safeInputTokens: 100,
  });

  assert.equal(plan.effectiveModel, DEEPSEEK_FLASH_MODEL);
  assert.equal(plan.modelType, DEEPSEEK_FLASH_MODEL_TYPE);
  assert.equal(plan.fallbackReason, 'estimated_context_exceeded');
  assert.equal(plan.estimatedPromptTokens, 101);
});

test('selectContextExecutionPlan keeps pro when prompt is within budget', () => {
  const plan = selectContextExecutionPlan({
    requestedModel: 'deepseek-v4-pro',
    requestedModelType: 'expert',
    promptForBudget: 'a'.repeat(400),
    safeInputTokens: 100,
  });

  assert.equal(plan.effectiveModel, 'deepseek-v4-pro');
  assert.equal(plan.modelType, 'expert');
  assert.equal(plan.fallbackReason, null);
});

test('selectContextExecutionPlan respects disabled fallback', () => {
  const plan = selectContextExecutionPlan({
    requestedModel: 'deepseek-v4-pro',
    requestedModelType: 'expert',
    promptForBudget: 'a'.repeat(404),
    safeInputTokens: 100,
    fallbackEnabled: false,
  });

  assert.equal(plan.effectiveModel, 'deepseek-v4-pro');
  assert.equal(plan.modelType, 'expert');
  assert.equal(plan.fallbackReason, null);
});

test('isContextLimitError detects context errors without treating rate limits as context overflow', () => {
  assert.equal(isContextLimitError(new Error('context length exceeded')), true);
  assert.equal(isContextLimitError(new Error('prompt is too long')), true);
  assert.equal(isContextLimitError(new Error('Rate limited (429)')), false);
  assert.equal(isContextLimitError(new Error('Session rate limited (40301)')), false);
});
