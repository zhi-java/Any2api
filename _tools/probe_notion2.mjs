/**
 * Notion API 深度探测 — 追踪 400 错误根因
 *
 * 目标：
 * 1. 检查 getSpacesInitial 完整响应（特别是空间特性和模型设置）
 * 2. 尝试多种 runInferenceTranscript 请求体变体
 * 3. 尝试直接抓取 Notion 前端 JS 中的模型和端点信息
 */

import fs from 'fs';

const PROBE_PATH = './probe.example.json';
const probe = JSON.parse(fs.readFileSync(PROBE_PATH, 'utf-8'));

console.log(`📋 Probe: ${probe.email}`);
console.log(`  user_id: ${probe.user_id}`);
console.log(`  space_id: ${probe.space_id}\n`);

function getCookieHeader(cookies) {
  return cookies.map(c => `${c.name}=${c.value}`).join('; ');
}

async function notionPost(endpoint, body, accept = 'application/json', extraHeaders = {}) {
  const url = `https://www.notion.so${endpoint}`;
  const headers = {
    'cookie': getCookieHeader(probe.cookies),
    'x-notion-active-user-header': probe.user_id,
    'x-notion-space-id': probe.space_id,
    'notion-client-version': probe.client_version,
    'notion-audit-log-platform': 'web',
    'accept': accept,
    'content-type': 'application/json',
    'accept-language': 'en-US,en;q=0.9',
    'origin': 'https://www.notion.so',
    'referer': 'https://www.notion.so/ai',
    'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/145.0.0.0 Safari/537.36',
    'sec-ch-ua': '"Google Chrome";v="145", "Not?A_Brand";v="8", "Chromium";v="145"',
    'sec-ch-ua-mobile': '?0',
    'sec-ch-ua-platform': '"Windows"',
    'sec-fetch-dest': 'empty',
    'sec-fetch-mode': 'cors',
    'sec-fetch-site': 'same-origin',
    ...extraHeaders,
  };
  const res = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body) });
  const text = await res.text();
  return { status: res.status, ok: res.ok, body: text };
}

// ============= 1. 完整检查 getSpacesInitial 响应 =============

console.log('=== 1. getSpacesInitial — 完整响应分析 ===');
const gsi = await notionPost('/api/v3/getSpacesInitial', {});
let gsiData;
try { gsiData = JSON.parse(gsi.body); } catch { console.log('❌ 不是 JSON'); process.exit(1); }

// 遍历用户的空间
const mySpaces = gsiData[probe.user_id]?.space || {};
const mySpace = mySpaces[probe.space_id];
if (mySpace) {
  console.log(`空间名称: ${mySpace.value?.name || '?'}`);
  console.log(`空间类型: ${mySpace.value?.type || '?'}`);

  // 检查 beta 特性
  const betaFeatures = mySpace.value?.beta_enabled_features || [];
  console.log(`\nBeta 特性 (${betaFeatures.length}):`);
  for (const feat of betaFeatures) console.log(`  - ${feat}`);

  // 检查设置
  const settings = mySpace.value?.settings || {};
  console.log(`\nSettings (${Object.keys(settings).length}):`);
  for (const [k, v] of Object.entries(settings)) {
    const val = typeof v === 'object' ? JSON.stringify(v).slice(0, 300) : String(v);
    console.log(`  ${k}: ${val}`);
  }

  // 检查 space_view
  const svKey = Object.keys(gsiData[probe.user_id]?.space_view || {}).find(k => k.includes(probe.space_id.slice(0, 8)));
  if (svKey) {
    const sv = gsiData[probe.user_id]?.space_view?.[svKey];
    console.log(`\nSpace view: ${svKey}`);
    if (sv?.value) {
      console.log(`  name: ${sv.value.name || '?'}`);
      console.log(`  space_id: ${sv.value.space_id || '?'}`);
      console.log(`  type: ${sv.value.type || '?'}`);
    }
  }
} else {
  console.log('⚠️ 在响应中找不到匹配的空间');
  // 打印所有空间 key
  console.log('所有空间 key:', Object.keys(mySpaces));
}

// ============= 2. 检查可用的 AI 端点 =============

console.log('\n\n=== 2. 探测 AI API 端点 ===');

// 方法：通过 Notion 前端 bundle 搜索端点
const endpoints = [
  '/api/v3/runInferenceTranscript',
  '/api/v3/getInferenceTranscriptsForUser',
  '/api/v3/saveTransactionsFanout',
  '/api/v3/syncRecordValuesSpaceInitial',
  '/api/v3/markInferenceTranscriptSeen',
  '/api/v3/getFollowUpQuestions',
];

for (const ep of endpoints) {
  try {
    const r = await notionPost(ep, {});
    console.log(`  ${ep}: ${r.status} (略)`);
  } catch (e) {
    console.log(`  ${ep}: ❌ ${e.message}`);
  }
}

// ============= 3. 尝试不同的 runInferenceTranscript 请求体变体 =============

console.log('\n\n=== 3. 请求体变体测试 ===');

function uuid() { return crypto.randomUUID(); }
function now() { return Date.now(); }

// 变体 A: 最简 payload，不加 thread_view
console.log('\n--- 变体 A: 最简 (无 thread_view) ---');
{
  const tid = uuid();
  const tidClean = tid.replace(/-/g, '');
  const p = {
    id: tid,
    spaceId: probe.space_id,
    threadId: tid,
    transactions: [{
      id: uuid(),
      shardId: 1234,
      spaceId: probe.space_id,
      transactions: [{
        type: 'update',
        operations: [
          { pointer: { table: 'thread', id: tid, spaceId: probe.space_id }, path: [], command: 'set', args: { type: 'workflow' } },
          { pointer: { table: 'step', id: uuid(), spaceId: probe.space_id }, path: [], command: 'set', args: { type: 'user', value: [{type:'text', text:'hi'}], id: uuid(), parent_id: tid, parent_table: 'thread', created_time: now(), last_edited_time: now() } },
        ]
      }]
    }],
    createThread: true,
    model: 'claude-sonnet-4-6',
    type: 'workflow',
  };
  const r = await notionPost('/api/v3/runInferenceTranscript', p, 'application/x-ndjson');
  console.log(`  状态: ${r.status} ${r.ok ? '✅' : '❌'}`);
  if (!r.ok) console.log(`  ${r.body.slice(0, 300)}`);
}

// 变体 B: 尝试使用无连字符的 spaceId
console.log('\n--- 变体 B: spaceId 无连字符 ---');
{
  const tid = uuid();
  const spaceIdClean = probe.space_id.replace(/-/g, '');
  const p = {
    id: tid,
    spaceId: spaceIdClean,
    threadId: tid,
    transactions: [{
      id: uuid(),
      shardId: 1234,
      spaceId: spaceIdClean,
      transactions: [{
        type: 'update',
        operations: [
          { pointer: { table: 'thread', id: tid, spaceId: spaceIdClean }, path: [], command: 'set', args: { type: 'workflow', lastEditedTime: now() } },
          { pointer: { table: 'step', id: uuid(), spaceId: spaceIdClean }, path: [], command: 'set', args: { type: 'user', value: [{type:'text', text:'hello'}], id: uuid(), parent_id: tid, parent_table: 'thread', created_time: now(), last_edited_time: now() } },
          { pointer: { table: 'step', id: uuid(), spaceId: spaceIdClean }, path: [], command: 'set', args: { type: 'config', value: { type: 'workflow', model: 'claude-sonnet-4-6' }, id: uuid(), parent_id: tid, parent_table: 'thread', created_time: now(), last_edited_time: now() } },
        ]
      }]
    }],
    createThread: true,
    model: 'claude-sonnet-4-6',
    type: 'workflow',
  };
  const r = await notionPost('/api/v3/runInferenceTranscript', p, 'application/x-ndjson');
  console.log(`  状态: ${r.status} ${r.ok ? '✅' : '❌'}`);
  if (!r.ok) console.log(`  ${r.body.slice(0, 300)}`);
}

// 变体 C: id = threadId (他们可能不一样)
console.log('\n--- 变体 C: id ≠ threadId (不同 UUID) ---');
{
  const tid = uuid();
  const reqId = uuid();
  const p = {
    id: reqId,
    spaceId: probe.space_id,
    threadId: tid,
    transactions: [{
      id: uuid(),
      shardId: 1234,
      spaceId: probe.space_id,
      transactions: [{
        type: 'update',
        operations: [
          { pointer: { table: 'thread', id: tid, spaceId: probe.space_id }, path: [], command: 'set', args: { type: 'workflow', lastEditedTime: now() } },
          { pointer: { table: 'step', id: uuid(), spaceId: probe.space_id }, path: [], command: 'set', args: { type: 'user', value: [{type:'text', text:'hello'}], id: uuid(), parent_id: tid, parent_table: 'thread', created_time: now(), last_edited_time: now() } },
        ]
      }]
    }],
    createThread: true,
    model: 'claude-sonnet-4-6',
    type: 'workflow',
  };
  const r = await notionPost('/api/v3/runInferenceTranscript', p, 'application/x-ndjson');
  console.log(`  状态: ${r.status} ${r.ok ? '✅' : '❌'}`);
  if (!r.ok) console.log(`  ${r.body.slice(0, 300)}`);
}

// 变体 D: 去掉 type:'workflow' 相关字段
console.log('\n--- 变体 D: 无 type/无 config step ---');
{
  const tid = uuid();
  const p = {
    id: tid,
    spaceId: probe.space_id,
    threadId: tid,
    transactions: [{
      id: uuid(),
      shardId: 1234,
      spaceId: probe.space_id,
      transactions: [{
        type: 'update',
        operations: [
          { pointer: { table: 'thread', id: tid, spaceId: probe.space_id }, path: [], command: 'set', args: { type: 'chat' } },
          { pointer: { table: 'step', id: uuid(), spaceId: probe.space_id }, path: [], command: 'set', args: { type: 'user', value: [{type:'text', text:'hello'}], id: uuid(), parent_id: tid, parent_table: 'thread', created_time: now(), last_edited_time: now() } },
        ]
      }]
    }],
    createThread: true,
    model: 'claude-sonnet-4-6',
    type: 'chat',
  };
  const r = await notionPost('/api/v3/runInferenceTranscript', p, 'application/x-ndjson');
  console.log(`  状态: ${r.status} ${r.ok ? '✅' : '❌'}`);
  if (!r.ok) console.log(`  ${r.body.slice(0, 300)}`);
}

// ============= 4. 抓取 Notion AI 页面 JS =============

console.log('\n\n=== 4. 从 Notion 前端页面提取 API 信息 ===');
try {
  const r = await fetch('https://www.notion.so/ai', {
    headers: {
      'cookie': getCookieHeader(probe.cookies),
      'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/145.0.0.0 Safari/537.36',
    }
  });
  const html = await r.text();
  console.log(`  页面大小: ${html.length} bytes`);

  // 查找 model 相关 JS
  const modelMatches = html.match(/[a-z]+-[a-z0-9]+-[0-9]+[a-z0-9.-]*/gi) || [];
  const aiModels = modelMatches.filter(m =>
    m.includes('sonnet') || m.includes('opus') || m.includes('haiku') ||
    m.includes('gpt') || m.includes('gemini') || m.includes('claude')
  );
  if (aiModels.length) {
    console.log('\n  页面中发现的 AI 模型引用:');
    for (const m of [...new Set(aiModels)]) console.log(`    - ${m}`);
  }

  // 查找 runInferenceTranscript 引用
  if (html.includes('runInference')) console.log('  ✅ 页面包含 runInferenceTranscript');
  if (html.includes('saveTransactionsFanout')) console.log('  ✅ 页面包含 saveTransactionsFanout');

  // 查找 manifest 或 chunk 文件名
  const chunkMatches = html.match(/\/_assets\/[\w.-]+\.js/g) || [];
  console.log(`\n  JS chunks: ${chunkMatches.length} 个`);

  // 检查一个主 JS chunk 来获取模型列表
  // 找主要的 app chunk
  const mainChunks = html.match(/\/_assets\/app-[\w]+\.js/g) || [];
  if (mainChunks.length) {
    const jsUrl = `https://www.notion.so${mainChunks[0]}`;
    const js = await fetch(jsUrl, {
      headers: {
        'cookie': getCookieHeader(probe.cookies),
        'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/145.0.0.0 Safari/537.36',
      }
    });
    const jsText = await js.text();
    console.log(`\n  JS chunk ${mainChunks[0]}: ${jsText.length} bytes`);

    // 搜索模型名
    for (const model of ['claude-sonnet', 'claude-opus', 'claude-haiku', 'gpt-4o', 'gemini']) {
      const idx = jsText.indexOf(model);
      if (idx > -1) {
        console.log(`  Found "${model}" at offset ${idx}, context: ${jsText.slice(Math.max(0, idx-50), idx+100)}`);
      }
    }
  }
} catch (e) {
  console.log(`❌ 抓取失败: ${e.message}`);
}

console.log('\n✅ 探测完成');