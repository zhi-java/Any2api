import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const runner = readFileSync(new URL('../../src/channels/deepseek/runner.js', import.meta.url), 'utf8');

test('DeepSeek Internal Event runner defaults Web search off', () => {
  assert.doesNotMatch(runner, /search_enabled\s*\?\?\s*true/);
  assert.match(runner, /search_enabled\s*\?\?\s*false/);
});
