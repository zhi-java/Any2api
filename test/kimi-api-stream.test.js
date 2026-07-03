import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import http from 'node:http';

function connectFrame(payload, flags = 0) {
  const data = Buffer.from(JSON.stringify(payload));
  const header = Buffer.alloc(5);
  header[0] = flags;
  header.writeUInt32BE(data.length, 1);
  return Buffer.concat([header, data]);
}

function requestCompletion(port) {
  let clientReq;
  const result = new Promise((resolve) => {
    clientReq = http.request({
      hostname: '127.0.0.1',
      port,
      path: '/v1/chat/completions',
      method: 'POST',
      headers: { 'content-type': 'application/json' },
    }, (res) => {
      let data = '';
      res.on('data', chunk => { data += chunk.toString(); });
      res.on('end', () => resolve({ status: res.statusCode, data }));
    });

    clientReq.on('error', err => resolve({ error: err.message }));
    clientReq.end(JSON.stringify({
      model: 'kimi-k2.6',
      messages: [{ role: 'user', content: 'ping' }],
      stream: true,
    }));
  });

  return { clientReq, result };
}

function requestClaudeMessages(port) {
  let clientReq;
  const result = new Promise((resolve) => {
    clientReq = http.request({
      hostname: '127.0.0.1',
      port,
      path: '/v1/messages',
      method: 'POST',
      headers: { 'content-type': 'application/json' },
    }, (res) => {
      let data = '';
      res.on('data', chunk => { data += chunk.toString(); });
      res.on('end', () => resolve({ status: res.statusCode, data }));
    });

    clientReq.on('error', err => resolve({ error: err.message }));
    clientReq.end(JSON.stringify({
      model: 'kimi-k2.6-thinking',
      max_tokens: 1024,
      messages: [{ role: 'user', content: 'ping' }],
      stream: true,
    }));
  });

  return { clientReq, result };
}

test('Kimi API stream is not aborted when the request body closes normally', async () => {
  process.env.KIMI_AUTH_TOKEN = 'fake-token-for-test';
  process.env.KIMI_AUTH_TOKENS = '';

  let upstreamCalled = false;
  let upstreamAborted = false;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, options = {}) => {
    if (!String(url).includes('kimi.gateway.chat')) {
      return originalFetch(url, options);
    }

    upstreamCalled = true;
    return await new Promise((resolve, reject) => {
      options.signal?.addEventListener('abort', () => {
        upstreamAborted = true;
        const err = new Error('mock aborted');
        err.name = 'AbortError';
        reject(err);
      });

      setTimeout(() => {
        const stream = new ReadableStream({
          start(controller) {
            controller.enqueue(connectFrame({
              op: 'set',
              mask: 'block.text',
              block: { text: { content: 'pong' } },
            }));
            controller.enqueue(connectFrame({ done: {} }));
            controller.close();
          },
        });
        resolve(new Response(stream, {
          status: 200,
          headers: { 'content-type': 'application/connect+json' },
        }));
      }, 50);
    });
  };

  const routes = (await import('../src/routes/index.js')).default;
  const app = express();
  app.use(express.json({ limit: '50mb' }));
  app.use(routes);

  const server = app.listen(0);
  await new Promise(resolve => server.once('listening', resolve));
  const { clientReq, result } = requestCompletion(server.address().port);

  try {
    const response = await Promise.race([
      result,
      new Promise(resolve => setTimeout(() => resolve({ timeout: true }), 1000)),
    ]);

    assert.equal(response.timeout, undefined);
    assert.equal(response.status, 200);
    assert.match(response.data, /pong/);
    assert.equal(upstreamCalled, true);
    assert.equal(upstreamAborted, false);
  } finally {
    clientReq.destroy();
    server.closeAllConnections?.();
    await new Promise(resolve => server.close(resolve));
    globalThis.fetch = originalFetch;
  }
});

test('Kimi Claude stream returns upstream model errors as normal text instead of interrupting', async () => {
  process.env.KIMI_AUTH_TOKEN = 'fake-token-for-test';
  process.env.KIMI_AUTH_TOKENS = '';

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, options = {}) => {
    if (!String(url).includes('kimi.gateway.chat')) {
      return originalFetch(url, options);
    }

    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(connectFrame({
          error: { message: 'System is currently busy. Please try again later.' },
        }));
        controller.close();
      },
    });
    return new Response(stream, {
      status: 200,
      headers: { 'content-type': 'application/connect+json' },
    });
  };

  const routes = (await import('../src/routes/index.js')).default;
  const app = express();
  app.use(express.json({ limit: '50mb' }));
  app.use(routes);

  const server = app.listen(0);
  await new Promise(resolve => server.once('listening', resolve));
  const { clientReq, result } = requestClaudeMessages(server.address().port);

  try {
    const response = await Promise.race([
      result,
      new Promise(resolve => setTimeout(() => resolve({ timeout: true }), 1000)),
    ]);

    assert.equal(response.timeout, undefined);
    assert.equal(response.status, 200);
    assert.match(response.data, /content_block_start/);
    assert.match(response.data, /System is currently busy\. Please try again later\./);
    assert.match(response.data, /message_delta/);
    assert.match(response.data, /message_stop/);
    assert.doesNotMatch(response.data, /"type":"error"/);
  } finally {
    clientReq.destroy();
    server.closeAllConnections?.();
    await new Promise(resolve => server.close(resolve));
    globalThis.fetch = originalFetch;
  }
});
