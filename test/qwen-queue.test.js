import test from 'node:test';
import assert from 'node:assert/strict';

import { QwenRequestQueue } from '../src/channels/qwen/queue.js';

test('QwenRequestQueue fails fast when no token can ever become available', async () => {
  const queue = new QwenRequestQueue({
    async acquireToken() {
      return null;
    },
    getNextAvailableDelayMs() {
      return null;
    },
    getUnavailableReason() {
      return 'No Qwen credentials configured. Set QWEN_TOKENS or QWEN_ACCOUNTS and restart the service.';
    },
  });

  await assert.rejects(
    () => queue.enqueueRequest(30_000),
    /No Qwen credentials configured/,
  );
});

test('QwenRequestQueue queues when a token may become available later', async () => {
  const releases = [];
  let slot = null;
  const queue = new QwenRequestQueue({
    async acquireToken() {
      const current = slot;
      slot = null;
      return current;
    },
    getNextAvailableDelayMs() {
      return 1;
    },
  });

  const pending = queue.enqueueRequest(1000);
  slot = {
    token: 'token',
    release() {
      releases.push('released');
    },
  };
  queue.dispatchQueued();

  const acquired = await pending;
  assert.equal(acquired.token, 'token');
  acquired.release();
  assert.deepEqual(releases, ['released']);
});

test('QwenRequestQueue rejects queued requests when token availability becomes impossible', async () => {
  let attempts = 0;
  const queue = new QwenRequestQueue({
    async acquireToken() {
      attempts++;
      return null;
    },
    getNextAvailableDelayMs() {
      return attempts < 2 ? 1 : null;
    },
    getUnavailableReason() {
      return 'All configured Qwen accounts exceeded the error limit. Check token validity or upstream errors.';
    },
  });

  await assert.rejects(
    () => queue.enqueueRequest(1000),
    /exceeded the error limit/,
  );
});
