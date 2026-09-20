import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// ---------------------------------------------------------------------------
// 凭据来源合并：.env（环境变量）与 config.json（磁盘）取并集去重
//
// 背景：旧行为是 deepMerge(env, disk) —— 磁盘**覆盖** env。一旦后台保存过
// 配置，磁盘里的 tokens 就永久压住 .env，改服务器 .env 完全不生效（尤其
// `tokens: []` 这种空数组也算"已定义"，会静默清空 env 凭据）。
//
// 另有两个更隐蔽的问题，一并在此固化：
//   ① env 凭据会被复制进 config.json（机密多一份副本）；
//   ② saveConfig → applyConfigToProcessEnv 把 config 值回写 process.env，
//      导致 .env / process.env / config.json 三者互相覆盖、来源不可追溯。
//
// 现在的语义：
//   - 凭据 = env ∪ disk（并集去重，env 在前）——两边都不丢；
//   - 其它配置项仍是 disk 覆盖 env（保持既有行为）；
//   - env 来源的凭据不写入磁盘，但禁用态照常持久化。
//
// token 是 64 字符无结构随机串（非 JWT），只能按字符串精确去重。
// ---------------------------------------------------------------------------

const ENV_KEYS = [
  'DS_TOKEN', 'DS_TOKENS', 'DS_ACCOUNTS', 'ZHI2API_CONFIG_PATH', 'ZHI2API_DATA_DIR',
];

function clearCredentialEnv() {
  for (const key of ENV_KEYS) delete process.env[key];
}

async function withEnv({ env = {}, disk = null } = {}) {
  clearCredentialEnv();
  const dir = mkdtempSync(join(tmpdir(), 'omni-merge-'));
  process.env.ZHI2API_CONFIG_PATH = join(dir, 'config.json');
  // 隔离宿主机 .env：loadEnvironment 会按候选路径回退，指向不存在的文件会继续
  // 找到 cwd/.env，把真实凭据读进来。放一个真实存在的空文件确保命中即停。
  const emptyEnvPath = join(dir, 'empty.env');
  writeFileSync(emptyEnvPath, '');
  process.env.ZHI2API_ENV_PATH = emptyEnvPath;

  for (const [key, value] of Object.entries(env)) process.env[key] = value;
  if (disk) writeFileSync(process.env.ZHI2API_CONFIG_PATH, JSON.stringify(disk));

  const configStore = await import('../../src/services/config-store.js');
  configStore.loadConfig({ force: true });
  return { dir, configStore };
}

function cleanup(dir) {
  rmSync(dir, { recursive: true, force: true });
  clearCredentialEnv();
}

test('凭据取并集：env 与磁盘里的 token 都生效，且 env 在前', async () => {
  const { dir, configStore } = await withEnv({
    env: { DS_TOKENS: 'env-token-1, env-token-2' },
    disk: { version: 1, deepseek: { tokens: ['disk-token-1'], accounts: [] } },
  });
  try {
    assert.deepEqual(
      configStore.getConfig().deepseek.tokens,
      ['env-token-1', 'env-token-2', 'disk-token-1'],
      '应合并两边凭据且 env 排在前面',
    );
  } finally {
    cleanup(dir);
  }
});

test('去重：env 与磁盘重复的 token 只保留一份；env 内部也去重', async () => {
  const { dir, configStore } = await withEnv({
    env: { DS_TOKENS: 'same-token, same-token, env-only' },
    disk: { version: 1, deepseek: { tokens: ['same-token', 'disk-only'], accounts: [] } },
  });
  try {
    assert.deepEqual(
      configStore.getConfig().deepseek.tokens,
      ['same-token', 'env-only', 'disk-only'],
      '重复 token 应被去掉，且保持 env 优先的稳定顺序',
    );
  } finally {
    cleanup(dir);
  }
});

test('关键回归：磁盘 tokens 为空数组时，env 凭据不再被清空', async () => {
  // 旧实现下 [] 是真值会覆盖 env，导致 .env 配了凭据却一个都不用。
  const { dir, configStore } = await withEnv({
    env: { DS_TOKENS: 'env-token' },
    disk: { version: 1, deepseek: { tokens: [], accounts: [] } },
  });
  try {
    assert.deepEqual(configStore.getConfig().deepseek.tokens, ['env-token'],
      '空数组不应清空 env 凭据');
  } finally {
    cleanup(dir);
  }
});

test('账号也取并集：按 email:password 去重', async () => {
  const { dir, configStore } = await withEnv({
    env: { DS_ACCOUNTS: 'a@x.com:pw1, dup@x.com:pw' },
    disk: {
      version: 1,
      deepseek: {
        tokens: [],
        accounts: [{ email: 'dup@x.com', password: 'pw' }, { email: 'b@x.com', password: 'pw2' }],
      },
    },
  });
  try {
    const accounts = configStore.getConfig().deepseek.accounts;
    assert.deepEqual(accounts.map(a => a.email), ['a@x.com', 'dup@x.com', 'b@x.com']);
    assert.equal(accounts.length, 3, '重复账号应只保留一份');
  } finally {
    cleanup(dir);
  }
});

test('单数 DS_TOKEN 与复数 DS_TOKENS 的既有回落行为不变', async () => {
  const { dir, configStore } = await withEnv({ env: { DS_TOKEN: 'single-token' } });
  try {
    assert.deepEqual(configStore.getConfig().deepseek.tokens, ['single-token']);
  } finally {
    cleanup(dir);
  }
});

test('其它配置项仍是磁盘优先（并集语义只针对凭据）', async () => {
  const { dir, configStore } = await withEnv({
    env: { MAX_CONCURRENT_PER_TOKEN: '9' },
    disk: { version: 1, deepseek: { tokens: [], accounts: [], maxConcurrentPerToken: 3 } },
  });
  try {
    assert.equal(configStore.getConfig().deepseek.maxConcurrentPerToken, 3,
      '非凭据字段应保持"磁盘覆盖 env"的既有行为');
  } finally {
    cleanup(dir);
  }
});

test('env 来源的凭据不写入 config.json（避免机密副本）', async () => {
  const { dir, configStore } = await withEnv({
    env: { DS_TOKENS: 'env-secret-token', DS_ACCOUNTS: 'env@x.com:pw' },
  });
  try {
    configStore.updateConfig({ server: { mergeThinking: true } });  // 任意一次保存
    const disk = JSON.parse(readFileSync(process.env.ZHI2API_CONFIG_PATH, 'utf8'));
    assert.deepEqual(disk.deepseek.tokens, [], 'env token 不应落盘');
    assert.deepEqual(disk.deepseek.accounts, [], 'env 账号不应落盘');
    // 但内存中仍然生效。
    assert.deepEqual(configStore.getConfig().deepseek.tokens, ['env-secret-token']);
  } finally {
    cleanup(dir);
  }
});

test('磁盘来源的凭据仍正常落盘（不因剔除逻辑误伤）', async () => {
  const { dir, configStore } = await withEnv({ env: {} });
  try {
    configStore.updateConfig({ deepseek: { tokens: ['admin-token'], accounts: [] } });
    const disk = JSON.parse(readFileSync(process.env.ZHI2API_CONFIG_PATH, 'utf8'));
    assert.deepEqual(disk.deepseek.tokens, ['admin-token'], '后台添加的凭据应落盘');
  } finally {
    cleanup(dir);
  }
});

test('保存配置不再回写 DS_TOKENS / DS_ACCOUNTS 到 process.env', async () => {
  const { dir, configStore } = await withEnv({ env: { DS_TOKENS: 'env-token' } });
  try {
    const before = process.env.DS_TOKENS;
    configStore.updateConfig({ deepseek: { tokens: ['admin-token'], accounts: [] } });
    assert.equal(process.env.DS_TOKENS, before,
      'DS_TOKENS 不应被 config 反向污染（否则 .env 改动会被永久压住）');
    assert.equal(process.env.DS_ACCOUNTS, undefined, 'DS_ACCOUNTS 也不应被回写');
  } finally {
    cleanup(dir);
  }
});

test('其它运行参数仍回写 process.env（保持既有契约）', async () => {
  const { dir, configStore } = await withEnv({ env: {} });
  try {
    configStore.updateConfig({ runtime: { sessionTtlSeconds: 120 } });
    assert.equal(process.env.SESSION_TTL, '120', '调优项回写行为不应被破坏');
  } finally {
    cleanup(dir);
  }
});

test('原子写：保存后无残留临时文件，且配置可完整解析', async () => {
  const { dir, configStore } = await withEnv({ env: {} });
  try {
    configStore.updateConfig({ deepseek: { tokens: ['t1', 't2'], accounts: [] } });
    const path = process.env.ZHI2API_CONFIG_PATH;
    assert.equal(existsSync(`${path}.tmp`), false, '不应残留 .tmp 文件');
    const disk = JSON.parse(readFileSync(path, 'utf8'));
    assert.deepEqual(disk.deepseek.tokens, ['t1', 't2']);
  } finally {
    cleanup(dir);
  }
});

test('损坏的 config.json 不会静默清空已加载的配置', async () => {
  const { dir, configStore } = await withEnv({ env: { DS_TOKENS: 'env-token' } });
  try {
    // 先写入一份有效配置并加载。
    configStore.updateConfig({ deepseek: { tokens: ['good-token'], accounts: [] } });
    assert.equal(configStore.getConfig().deepseek.tokens.includes('good-token'), true);

    // 把文件写成截断的 JSON（模拟进程被杀导致的半截写入）。
    writeFileSync(process.env.ZHI2API_CONFIG_PATH, '{"version":1,"deepseek":{"tokens":["goo');
    configStore.loadConfig({ force: true });

    assert.ok(configStore.getConfigLoadError(), '应记录加载错误供后台展示');
    // 内存中应保留上一次的有效配置，而不是回落成空配置。
    assert.equal(configStore.getConfig().deepseek.tokens.includes('good-token'), true,
      '损坏文件不应清空内存中的既有凭据');
  } finally {
    cleanup(dir);
  }
});
