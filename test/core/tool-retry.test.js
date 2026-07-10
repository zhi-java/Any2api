import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createPromptPlan } from '../../src/core/prompt-strategy.js';
import {
  attemptToolParseWithRetry,
  classifyToolFailure,
  getFcErrorRetryMaxAttempts,
  getToolContinuationPrompt,
  getToolErrorRetryPrompt,
  isFcErrorRetryEnabled,
  mergeTruncatedAndContinuation,
} from '../../src/core/tool-retry.js';

const tools = [{
  type: 'function',
  function: {
    name: 'Read',
    description: 'Read a file',
    parameters: {
      type: 'object',
      properties: { file_path: { type: 'string' } },
      required: ['file_path'],
    },
  },
}];

function rawReq(body = {}) {
  return {
    body,
    headers: {},
    omni: {
      promptInjectionEnabled: true,
      rawRequestJsonText: JSON.stringify(body),
    },
  };
}

function plan() {
  return createPromptPlan({ req: rawReq({ messages: [{ role: 'user', content: 'hi' }] }), tools, toolChoice: 'auto' });
}

function validXml(trigger, path = 'README.md') {
  return `${trigger}\n<function_calls><function_call><tool>Read</tool><args_json>{"file_path":"${path}"}</args_json></function_call></function_calls>`;
}

test('retry configuration reads runtime config and clamps values', async () => {
  const oldPath = process.env.ZHI2API_CONFIG_PATH;
  const dir = mkdtempSync(join(tmpdir(), 'omni-tool-retry-'));
  process.env.ZHI2API_CONFIG_PATH = join(dir, 'config.json');
  try {
    const { loadConfig, updateConfig } = await import('../../src/services/config-store.js');
    loadConfig({ force: true });
    assert.equal(isFcErrorRetryEnabled(), true);
    assert.equal(getFcErrorRetryMaxAttempts(), 3);

    updateConfig({ runtime: { enableFcErrorRetry: false, fcErrorRetryMaxAttempts: 100 } });
    assert.equal(isFcErrorRetryEnabled(), false);
    assert.equal(getFcErrorRetryMaxAttempts(), 10);

    updateConfig({ runtime: { fcErrorRetryMaxAttempts: 0 } });
    assert.equal(getFcErrorRetryMaxAttempts(), 1);
  } finally {
    const { updateConfig } = await import('../../src/services/config-store.js');
    updateConfig({ runtime: { enableFcErrorRetry: true, fcErrorRetryMaxAttempts: 3 } });
    if (oldPath == null) delete process.env.ZHI2API_CONFIG_PATH;
    else process.env.ZHI2API_CONFIG_PATH = oldPath;
    rmSync(dir, { recursive: true, force: true });
  }
});

test('no_fc does not call retry callback and returns ordinary content', async () => {
  const promptPlan = plan();
  let called = false;
  const result = await attemptToolParseWithRetry({
    content: 'ordinary answer',
    promptPlan,
    retryToolRequest: async () => { called = true; return ''; },
  });
  assert.equal(called, false);
  assert.equal(result.failureType, 'no_fc');
  assert.equal(result.content, 'ordinary answer');
});

test('syntax_error builds rewrite prompt and retries successfully', async () => {
  const promptPlan = plan();
  let seenPrompt = '';
  const result = await attemptToolParseWithRetry({
    content: `${validXml(promptPlan.triggerSignal)} trailing`,
    promptPlan,
    retryToolRequest: async ({ retryPrompt, failureType }) => {
      seenPrompt = retryPrompt;
      assert.equal(failureType, 'syntax_error');
      return validXml(promptPlan.triggerSignal, 'fixed.txt');
    },
    maxAttempts: 2,
  });
  assert.match(seenPrompt, /你上一次尝试调用工具/);
  assert.match(seenPrompt, /Unexpected text after/);
  assert.equal(result.toolCalls.length, 1);
  assert.equal(JSON.parse(result.toolCalls[0].function.arguments).file_path, 'fixed.txt');
});

test('schema_error builds rewrite prompt and retries successfully', async () => {
  const promptPlan = plan();
  const result = await attemptToolParseWithRetry({
    content: `${promptPlan.triggerSignal}\n<function_calls><function_call><tool>Read</tool><args_json>{}</args_json></function_call></function_calls>`,
    promptPlan,
    retryToolRequest: async ({ retryPrompt, failureType, errorDetails }) => {
      assert.equal(failureType, 'schema_error');
      assert.match(errorDetails, /missing required property/);
      assert.match(retryPrompt, /参数必须与上方工具列表中声明的 schema 匹配/);
      return validXml(promptPlan.triggerSignal, 'schema-fixed.txt');
    },
    maxAttempts: 2,
  });
  assert.equal(JSON.parse(result.toolCalls[0].function.arguments).file_path, 'schema-fixed.txt');
});

test('truncated output builds continuation prompt and merges exact continuation', async () => {
  const promptPlan = plan();
  const truncated = `${promptPlan.triggerSignal}\n<function_calls><function_call><tool>Read</tool><args_json>{"file_path":"line\\n`;
  const continuation = `two"}</args_json></function_call></function_calls>`;
  const result = await attemptToolParseWithRetry({
    content: truncated,
    promptPlan,
    retryToolRequest: async ({ retryPrompt, failureType }) => {
      assert.equal(failureType, 'truncated');
      assert.match(retryPrompt, /工具调用 XML 完成前被截断/);
      return continuation;
    },
    maxAttempts: 2,
  });
  assert.equal(JSON.parse(result.toolCalls[0].function.arguments).file_path, 'line\ntwo');
  assert.equal(result.finalContent, truncated + continuation);
});

test('truncated retry accepts full rewrite when response restarts with trigger', async () => {
  const promptPlan = plan();
  const result = await attemptToolParseWithRetry({
    content: `${promptPlan.triggerSignal}\n<function_calls><function_call><tool>Read</tool><args_json>{"file_path":"a"}`,
    promptPlan,
    retryToolRequest: async () => validXml(promptPlan.triggerSignal, 'rewrite.txt'),
    maxAttempts: 2,
  });
  assert.equal(JSON.parse(result.toolCalls[0].function.arguments).file_path, 'rewrite.txt');
});

test('retry disabled returns failure without callback', async () => {
  const promptPlan = plan();
  let called = false;
  const result = await attemptToolParseWithRetry({
    content: `${validXml(promptPlan.triggerSignal)} trailing`,
    promptPlan,
    retryEnabled: false,
    retryToolRequest: async () => { called = true; return validXml(promptPlan.triggerSignal); },
  });
  assert.equal(called, false);
  assert.equal(result.toolCalls, null);
  assert.equal(result.failureType, 'syntax_error');
});

test('max attempts are respected and explicit zero still parses once', async () => {
  const promptPlan = plan();
  const valid = await attemptToolParseWithRetry({
    content: validXml(promptPlan.triggerSignal, 'once.txt'),
    promptPlan,
    maxAttempts: 0,
  });
  assert.equal(JSON.parse(valid.toolCalls[0].function.arguments).file_path, 'once.txt');

  let calls = 0;
  const failed = await attemptToolParseWithRetry({
    content: `${validXml(promptPlan.triggerSignal)} trailing`,
    promptPlan,
    maxAttempts: 2,
    retryToolRequest: async () => {
      calls += 1;
      return `${validXml(promptPlan.triggerSignal)} still trailing`;
    },
  });
  assert.equal(calls, 1);
  assert.equal(failed.toolCalls, null);
  assert.equal(failed.attempts, 2);
});

test('classifyToolFailure and prompt builders expose expected wording', () => {
  const promptPlan = plan();
  assert.equal(classifyToolFailure('hello', promptPlan.triggerSignal), 'no_fc');
  assert.equal(classifyToolFailure(`${promptPlan.triggerSignal}\n<function_calls>`, promptPlan.triggerSignal), 'truncated');
  assert.equal(classifyToolFailure(`${promptPlan.triggerSignal}\nno xml`, promptPlan.triggerSignal), 'syntax_error');
  assert.match(getToolErrorRetryPrompt('bad', 'details', promptPlan.triggerSignal), /请重试/);
  assert.match(getToolContinuationPrompt('tail', 'missing close'), /选项 A/);
  assert.equal(mergeTruncatedAndContinuation('a\n', '\nb'), 'a\n\nb');
});
