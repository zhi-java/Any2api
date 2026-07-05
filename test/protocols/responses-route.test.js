import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import express from 'express';

import apiRoutes from '../../src/routes/api.js';

const apiRoute = readFileSync('D:/tools/Any2api/src/routes/api.js', 'utf8');

function responsesRouteBlock() {
  const start = apiRoute.indexOf("router.post('/responses'");
  assert.notEqual(start, -1, 'responses route should exist');
  const end = apiRoute.indexOf('// ============= 模型列表', start);
  assert.notEqual(end, -1, 'responses route should end before models route');
  return apiRoute.slice(start, end);
}

function createTestApp() {
  const app = express();
  app.use(express.json({
    verify: (req, _res, buf) => {
      req.rawBody = Buffer.from(buf);
    },
  }));
  app.use('/v1', apiRoutes);
  return app;
}

async function postJson(path, body) {
  const server = createServer(createTestApp());
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  try {
    const res = await fetch(`http://127.0.0.1:${port}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    return {
      status: res.status,
      contentType: res.headers.get('content-type') || '',
      body: await res.text(),
    };
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
}

test('/v1/responses route uses Internal Event path, not Chat Completions bridge', () => {
  const block = responsesRouteBlock();
  assert.match(block, /createResponsesRequestAdapter/);
  assert.match(block, /prepareInternalGeneration/);
  assert.match(block, /generateInternalEvents/);
  assert.match(block, /renderResponses/);
  for (const forbidden of [
    'deepseek.handleOpenAI',
    'handleGLMCompletion',
    'handleQwenCompletion',
    'handleKimiCompletion',
    'handleOpenAICompletion',
    'createChatCompletionsRequestAdapter',
    'renderChatCompletions',
  ]) {
    assert.equal(block.includes(forbidden), false, `responses route must not call ${forbidden}`);
  }
});

test('forced streaming middleware uses path matching so query strings do not bypass it', () => {
  assert.match(apiRoute, /req\.path === '\/chat\/completions'/);
  assert.match(apiRoute, /req\.path === '\/messages'/);
  assert.doesNotMatch(apiRoute, /originalUrl\?\.endsWith\('\/chat\/completions'\)/);
});

test('/v1/chat/completions rejects stream false even with query string', async () => {
  const res = await postJson('/v1/chat/completions?trace=1', {
    model: 'deepseek-v4-flash',
    messages: [{ role: 'user', content: 'hello' }],
    stream: false,
  });
  assert.equal(res.status, 400);
  const json = JSON.parse(res.body);
  assert.equal(json.error.code, 'stream_required');
});

test('/v1/messages rejects stream false even with query string', async () => {
  const res = await postJson('/v1/messages?trace=1', {
    model: 'deepseek-v4-flash',
    max_tokens: 100,
    messages: [{ role: 'user', content: 'hello' }],
    stream: false,
  });
  assert.equal(res.status, 400);
  const json = JSON.parse(res.body);
  assert.equal(json.type, 'error');
  assert.equal(json.error.type, 'invalid_request_error');
});

test('/v1/responses supports Qwen through Internal Event runner', async () => {
  const res = await postJson('/v1/responses', {
    model: 'qwen3.7-plus',
    input: 'hello',
    stream: true,
  });
  assert.equal(res.status, 200);
  assert.match(res.contentType, /text\/event-stream/);
  assert.match(res.body, /event: response\.created/);
  assert.match(res.body, /event: response\.(failed|completed)/);
  if (res.body.includes('event: response.failed')) {
    assert.match(res.body, /No Qwen credentials configured|Qwen/);
  } else {
    assert.match(res.body, /event: response\.completed/);
  }
});

test('/v1/responses returns model_not_found before SSE headers for unknown models', async () => {
  const res = await postJson('/v1/responses', {
    model: 'not-a-real-model',
    input: 'hello',
    stream: true,
  });
  assert.equal(res.status, 400);
  assert.match(res.contentType, /application\/json/);
  assert.doesNotMatch(res.contentType, /text\/event-stream/);
  const json = JSON.parse(res.body);
  assert.equal(json.error.code, 'model_not_found');
});
