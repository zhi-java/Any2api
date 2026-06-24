/**
 * Notion — dump AI settings + 从 JS 提取实际请求体格式
 */

import fs from 'fs';

const probe = JSON.parse(fs.readFileSync('./probe.example.json', 'utf-8'));
const cookie = probe.cookies.map(c => `${c.name}=${c.value}`).join('; ');

const baseHeaders = {
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

async function notionPost(endpoint, body) {
  const res = await fetch(`https://www.notion.so${endpoint}`, { method:'POST', headers: baseHeaders, body: JSON.stringify(body) });
  return { status: res.status, ok: res.ok, text: await res.text() };
}

// ===== 1. getSpacesInitial — dump 完整空间设置 =====
console.log('=== getSpacesInitial — 完整空间设置 ===\n');
const gsi = await notionPost('/api/v3/getSpacesInitial', {});
const gsiData = JSON.parse(gsi.text);
const spaceData = gsiData?.users?.[probe.user_id]?.space?.[probe.space_id]?.value;
if (spaceData) {
  console.log('settings:', JSON.stringify(spaceData.settings, null, 2));
}

// space_view settings
const svData = gsiData?.users?.[probe.user_id]?.space_view?.[probe.space_id]?.value;
// Actually the space_view key is different from space_id
console.log('\nspace_view data:');
for (const [k, v] of Object.entries(gsiData?.users?.[probe.user_id]?.space_view || {})) {
  console.log(`[${k}]:`, JSON.stringify(v?.value?.settings, null, 2).slice(0, 1000));
}

// ===== 2. 从 JS chunk 提取 API payload 格式 =====
console.log('\n\n=== JS chunk — 搜索推理相关代码 ===\n');
const jsRes = await fetch('https://www.notion.so/_assets/app-2542823ecd6b38c2.js', {
  headers: { 'cookie': cookie, 'user-agent': 'Mozilla/5.0 Chrome/145.0.0.0 Safari/537.36' }
});
const js = await jsRes.text();

// Search for "runInferenceTranscript" call sites with surrounding code
let idx = -1;
let found = 0;
while ((idx = js.indexOf('runInferenceTranscript', idx + 1)) !== -1 && found < 5) {
  found++;
  console.log(`\n=== runInferenceTranscript #${found} at offset ${idx} ===`);
  // Go backwards to find the start of the function/object
  const start = Math.max(0, idx - 500);
  const end = Math.min(js.length, idx + 600);
  let snippet = js.slice(start, end);
  // Try to find the enclosing function signature
  console.log(snippet);
}

// Search for "createThread" usage
console.log('\n\n=== createThread 上下文 ===\n');
idx = js.indexOf('createThread');
if (idx > -1) {
  console.log('位置:', idx);
  console.log(js.slice(Math.max(0, idx - 400), idx + 400));
}

// Search for "shardId" context
console.log('\n\n=== shardId 上下文 ===\n');
idx = js.indexOf('"shardId"');
if (idx === -1) idx = js.indexOf('shardId');
if (idx > -1) {
  console.log(js.slice(Math.max(0, idx - 200), idx + 300));
}

// Search for how transactions are built
console.log('\n\n=== "transactions" (JSON key) 上下文 ===\n');
idx = js.indexOf('"transactions"');
if (idx > -1) {
  console.log(js.slice(Math.max(0, idx - 200), idx + 300));
}

// Search for "saveTransactionsFanout" in JS
console.log('\n\n=== saveTransactionsFanout 上下文 ===\n');
idx = -1;
found = 0;
while ((idx = js.indexOf('saveTransactionsFanout', idx + 1)) !== -1 && found < 3) {
  found++;
  console.log(`\n#${found} at ${idx}:`);
  console.log(js.slice(Math.max(0, idx - 300), idx + 400));
}