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
