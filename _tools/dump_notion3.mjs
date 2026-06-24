/**
 * Notion — 获取空间 AI 设置 + JS 模型列表
 */

import fs from 'fs';

const probe = JSON.parse(fs.readFileSync('./probe.example.json', 'utf-8'));
const cookie = probe.cookies.map(c => `${c.name}=${c.value}`).join('; ');

const headers = {
  'cookie': cookie,
  'x-notion-active-user-header': probe.user_id,
  'x-notion-space-id': probe.space_id,
  'notion-client-version': probe.client_version,
  'notion-audit-log-platform': 'web',
  'accept': 'application/json',
  'content-type': 'application/json',
  'accept-language': 'en-US,en;q=0.9',
  'origin': 'https://www.notion.so',
  'referer': 'https://www.notion.so/ai',
  'user-agent': 'Mozilla/5.0 Chrome/145.0.0.0 Safari/537.36',
};

async function post(endpoint, body) {
  const r = await fetch(`https://www.notion.so${endpoint}`, { method:'POST', headers, body:JSON.stringify(body) });
  return r.ok ? await r.json() : { error: r.status, text: await r.text() };
}

// ===== 1. 获取 GSI 并 dump 完整结构 =====
console.log('=== getSpacesInitial ===\n');
const gsi = await post('/api/v3/getSpacesInitial', {});

if (gsi.error) { console.log('ERROR:', gsi); process.exit(1); }

const u = gsi?.users?.[probe.user_id];
if (!u) { console.log('No user data'); process.exit(1); }

// Dump space
for (const [k, v] of Object.entries(u.space || {})) {
  if (k === probe.space_id) {
    const val = v?.value || v;
    console.log(`Space ${k}:`);
    console.log(`  name: ${val.name}`);
    console.log(`  plan_type: ${val.plan_type}`);
    console.log(`  beta_enabled: ${val.beta_enabled}`);
    console.log(`  beta_enabled_features:`, val.beta_enabled_features);
    // Print all keys
    console.log(`  keys: ${Object.keys(val).join(', ')}`);
    console.log(`  settings:`, JSON.stringify(val.settings, null, 2));
  }
}

// Dump space_view
for (const [k, v] of Object.entries(u.space_view || {})) {
  const val = v?.value || v;
  console.log(`\nSpaceView ${k}:`);
  console.log(`  settings:`, JSON.stringify(val.settings, null, 2));
}

// ===== 2. 搜索 JS 中的 AI 模型配置 =====
console.log('\n\n=== JS 模型搜索 ===\n');
const jsRes = await fetch('https://www.notion.so/_assets/app-2542823ecd6b38c2.js', {
  headers: { 'cookie': cookie, 'user-agent': 'Mozilla/5.0 Chrome/145.0.0.0 Safari/537.36' }
});
const js = await jsRes.text();

// 搜索模型相关字符串
const targets = [
  '"claude-sonnet', '"model"', '"workflow"', 'inference/', 'x-ndjson',
  '"enable_ai_web_search"', '"enable_ai_feature"', 'enableAgent',
  '"claude"', '"gpt-4"', '"gemini"', '"createThread"'
];

for (const t of targets) {
  let pos = 0, count = 0;
  const results = [];
  while ((pos = js.indexOf(t, pos + 1)) !== -1 && count < 2) {
    const ctx = js.slice(Math.max(0, pos - 100), pos + 150).replace(/\n/g, ' ');
    results.push({ pos, ctx });
    count++;
  }
  if (results.length) {
    console.log(`\n--- ${t} (${count} hits) ---`);
    for (const r of results) console.log(`  [${r.pos}]: ${r.ctx}`);
  }
}

// 搜索 "runInferenceTranscript" 函数名周围的代码
// 这可能是定义在 key 映射中
const defs = js.match(/["']runInferenceTranscript["'][^,}]*[,}]/g) || [];
console.log('\n\n--- runInferenceTranscript 定义 ---');
for (const d of defs) console.log('  ', d);

// 找完整的 API path 定义代码块
const epStart = js.indexOf('"runInferenceTranscript"');
if (epStart > -1) {
  console.log('\n--- runInferenceTranscript 周围代码 (600字) ---');
  console.log(js.slice(Math.max(0, epStart - 250), epStart + 350));
}

// 搜索 "inferenceTranscript" 相关
console.log('\n\n--- inferenceTranscript 相关 ---');
let p = -1, c = 0;
while ((p = js.indexOf('inferenceTranscript', p + 1)) !== -1 && c < 10) {
  console.log(`  [${p}]: ${js.slice(Math.max(0, p - 60), p + 80).replace(/\n/g, ' ')}`);
  c++;
}

// 搜索所有已知模型名
console.log('\n\n--- 模型名搜索 ---');
for (const model of ['sonnet', 'opus', 'haiku', 'gpt-4o', 'gpt4', 'gemini']) {
  let p = -1, c = 0;
  while ((p = js.indexOf(model, p + 1)) !== -1 && c < 2) {
    const ctx = js.slice(Math.max(0, p - 40), p + 60);
    console.log(`  ${model} [${p}]: ${ctx.replace(/\n/g, ' ')}`);
    c++;
  }
}

// 搜索 model 映射对象
const modelPatterns = [
  'llmModels', 'Models:', 'models:', 'modelMap', 'model_list', 'aiModels',
  'AI_MODEL', 'AVAILABLE_MODELS', 'SUPPORTED_MODELS',
  'getModel', 'getModels', 'availableModels',
];
console.log('\n\n--- 模型列表变量搜索 ---');
for (const pat of modelPatterns) {
  const idx = js.indexOf(pat);
  if (idx > -1) {
    console.log(`\n  ${pat} at ${idx}:`);
    console.log(`    ${js.slice(idx, idx + 200).replace(/\n/g, ' ')}`);
  }
}