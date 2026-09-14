import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import express from 'express';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// ---------------------------------------------------------------------------
// 客户端（如各类 Agent / IDE 插件）会调用 /v1/models 自动识别模型的上下文
// 长度。OpenAI 官方 Model 对象并无该字段，各客户端探测的键名也不统一
// （context_length / context_window / max_context_tokens / max_model_len…），
// 因此需要同时给出多种别名。缺失会导致客户端识别不到上下文长度。
// ---------------------------------------------------------------------------

async function withServer(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'omni-models-'));
  process.env.ZHI2API_CONFIG_PATH = join(dir, 'config.json');
  const emptyEnv = join(dir, 'empty.env');
  writeFileSync(emptyEnv, '');
  process.env.ZHI2API_ENV_PATH = emptyEnv;

  const { loadConfig } = await import('../../src/services/config-store.js');
  loadConfig({ force: true });

  const apiRoutes = (await import('../../src/routes/api.js')).default;
  const app = express();
  app.use(express.json());
  app.use('/v1', apiRoutes);
  const server = createServer(app);
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const { port } = server.address();
  try {
    return await fn(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise(r => server.close(r));
    rmSync(dir, { recursive: true, force: true });
  }
}

test('/v1/models 为每个模型给出多种上下文长度字段别名', async () => {
  await withServer(async base => {
    const res = await fetch(`${base}/v1/models`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.object, 'list');
    assert.ok(body.data.length >= 1, '应至少有一个模型');

    const model = body.data[0];
    assert.equal(model.id, 'deepseek-flash');

    // 各客户端探测的键名都要有，且值一致
    const CONTEXT_KEYS = [
      'context_length',
      'context_window',
      'max_context_length',
      'max_context_tokens',
      'max_model_len',
      'max_input_tokens',
    ];
    for (const key of CONTEXT_KEYS) {
      assert.equal(typeof model[key], 'number', `${key} 应为数字`);
      assert.equal(model[key], 131072, `${key} 应为 128K`);
    }

    // 输出上限单独给出，且不应与上下文窗口混同
    assert.equal(model.max_output_tokens, 8192);
    assert.equal(model.max_completion_tokens, 8192);

    // OpenRouter 风格的嵌套字段
    assert.equal(model.top_provider.context_length, 131072);
    assert.equal(model.top_provider.max_completion_tokens, 8192);

    // OpenAI 基础字段保持兼容
    assert.equal(model.object, 'model');
    assert.equal(model.owned_by, 'deepseek');
    assert.equal(typeof model.created, 'number');
  });
});

test('/v1/models/:id 单模型查询返回同样的元数据', async () => {
  await withServer(async base => {
    const res = await fetch(`${base}/v1/models/deepseek-flash`);
    assert.equal(res.status, 200);
    const model = await res.json();
    assert.equal(model.id, 'deepseek-flash');
    assert.equal(model.context_length, 131072);
    assert.equal(model.max_output_tokens, 8192);
  });
});

test('/v1/models/:id 对未知模型返回 404 model_not_found', async () => {
  await withServer(async base => {
    const res = await fetch(`${base}/v1/models/not-a-real-model`);
    assert.equal(res.status, 404);
    const body = await res.json();
    assert.equal(body.error.code, 'model_not_found');
  });
});

test('上下文长度可通过配置覆盖', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'omni-models-cfg-'));
  const prev = process.env.ZHI2API_CONFIG_PATH;
  const prevEnv = process.env.ZHI2API_ENV_PATH;
  process.env.ZHI2API_CONFIG_PATH = join(dir, 'config.json');
  const emptyEnv = join(dir, 'empty.env');
  writeFileSync(emptyEnv, '');
  process.env.ZHI2API_ENV_PATH = emptyEnv;
  try {
    const { loadConfig, updateConfig } = await import('../../src/services/config-store.js');
    loadConfig({ force: true });
    updateConfig({ deepseek: { contextLength: 65536, maxOutputTokens: 4096 } });

    const { toOpenAIModel } = await import('../../src/channels/deepseek/models.js');
    const model = toOpenAIModel('deepseek-flash');
    assert.equal(model.context_length, 65536);
    assert.equal(model.max_output_tokens, 4096);
  } finally {
    if (prev == null) delete process.env.ZHI2API_CONFIG_PATH;
    else process.env.ZHI2API_CONFIG_PATH = prev;
    if (prevEnv == null) delete process.env.ZHI2API_ENV_PATH;
    else process.env.ZHI2API_ENV_PATH = prevEnv;
    rmSync(dir, { recursive: true, force: true });
  }
});
