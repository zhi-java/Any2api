import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const runnerSource = readFileSync(new URL('../../src/channels/deepseek/runner.js', import.meta.url), 'utf8');
const apiRouteSource = readFileSync(new URL('../../src/routes/api.js', import.meta.url), 'utf8');

test('DeepSeek runner listens to response close, not request close, for SSE cancellation', () => {
  assert.match(apiRouteSource, /generateInternalEvents\(internalRequest, \{ req, res \}\)/);
  assert.match(runnerSource, /const responseStream = context\?\.res/);
  assert.match(runnerSource, /responseStream\.on\('close', onClose\)/);
  assert.doesNotMatch(runnerSource, /req\.on\('close', onClose\)/);
  assert.doesNotMatch(runnerSource, /req\.off\('close', onClose\)/);
});

test('DeepSeek runner uses Toolify prompt strategy and retry instead of old JSON pseudo-tool parser', () => {
  assert.match(runnerSource, /createPromptPlan/);
  assert.match(runnerSource, /preprocessMessagesForToolify/);
  assert.match(runnerSource, /promptWithToolInstructions/);
  assert.match(runnerSource, /latestPromptWithToolInstructions/);
  assert.match(runnerSource, /attemptToolParseWithRetry/);
  assert.match(runnerSource, /collectParsedStreamContent/);
  assert.doesNotMatch(runnerSource, /createJsonContentExtractor/);
  assert.doesNotMatch(runnerSource, /extractAssistantResponse/);
  assert.doesNotMatch(runnerSource, /parseToolCallsFromText/);
  assert.doesNotMatch(runnerSource, /buildToolInstructions/);
});

test('runners keep the late pseudo-call recovery pass after stream end', () => {
  const commonRunnerSource = readFileSync(new URL('../../src/channels/common-internal-runner.js', import.meta.url), 'utf8');
  for (const source of [runnerSource, commonRunnerSource]) {
    assert.match(source, /Late tool recovery failed/);
    assert.match(source, /lateResult\?\.failureType && lateResult\.failureType !== 'no_fc'/);
  }
});

test('runners do not backfill streamed message text into reasoning at stream end', () => {
  const commonRunnerSource = readFileSync(new URL('../../src/channels/common-internal-runner.js', import.meta.url), 'utf8');
  for (const source of [runnerSource, commonRunnerSource]) {
    // 末尾回填 reasoning 无法流式，必须已移除
    assert.doesNotMatch(source, /detectedToolCalls\?\.length && !reasoningContent && visibleContent/);
    assert.match(source, /不要在流结束后把已流式发出的 message 文本/);
  }
});

test('runners defer message.started until content, tool, or reasoning completion', () => {
  const commonRunnerSource = readFileSync(new URL('../../src/channels/common-internal-runner.js', import.meta.url), 'utf8');
  for (const source of [runnerSource, commonRunnerSource]) {
    // message.started 不再在 run.started 之后无条件发出
    assert.doesNotMatch(source, /createRunStarted\([^)]*\);\s*\n\s*yield createMessageStarted/);
    // 通过 ensureMessageStarted 懒发 message.started
    assert.match(source, /ensureMessageStarted = function\*/);
    assert.match(source, /for \(const event of ensureMessageStarted\(\)\) yield event/);
  }
});
