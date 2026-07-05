import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const runner = readFileSync('D:/tools/Any2api/src/channels/deepseek/runner.js', 'utf8');

test('DeepSeek Internal Event runner defaults Web search off', () => {
  assert.doesNotMatch(runner, /search_enabled\s*\?\?\s*true/);
  assert.match(runner, /search_enabled\s*\?\?\s*false/);
});
