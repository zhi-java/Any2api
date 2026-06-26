import test from 'node:test';
import assert from 'node:assert/strict';

process.env.DS_TOKENS = 'test-token';
process.env.DS_ACCOUNTS = '';
process.env.DS_ACCOUNTS_EXTENDED = '';

const { isInvalidChatSessionError } = await import('../src/utils/sse.js');

test('isInvalidChatSessionError detects DeepSeek stale session errors', () => {
  assert.equal(isInvalidChatSessionError(0, 'invalid chat session id'), true);
  assert.equal(isInvalidChatSessionError('0', 'Invalid Chat Session ID'), true);
});

test('isInvalidChatSessionError ignores unrelated code 0 errors', () => {
  assert.equal(isInvalidChatSessionError(0, 'user is muted'), false);
  assert.equal(isInvalidChatSessionError(40301, 'invalid chat session id'), false);
});
