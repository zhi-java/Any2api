/**
 * Notion API 探测脚本
 *
 * 目标：
 * 1. 验证 Probe JSON 认证是否有效
 * 2. 探测实际可用的模型列表
 * 3. 测试 runInferenceTranscript 的请求体结构
 */

import fs from 'fs';

// ============= 配置 =============

const PROBE_PATH = './probe.example.json';
let probeRaw;
try {
  probeRaw = fs.readFileSync(PROBE_PATH, 'utf-8');
} catch (e) {
  console.error(`❌ 无法读取 ${PROBE_PATH}: ${e.message}`);
  process.exit(1);
}

const probe = JSON.parse(probeRaw);
console.log(`📋 Probe loaded: ${probe.email}`);
console.log(`  user_id: ${probe.user_id}`);
console.log(`  space_id: ${probe.space_id}`);
console.log(`  client_version: ${probe.client_version}`);
console.log(`  cookies: ${probe.cookies.length} entries`);

// ============= 请求头构建 =============

const CHROME_VERSION = '145';
const UPSTREAM = {
  baseURL: 'https://www.notion.so',
  originURL: 'https://www.notion.so',
  homeURL: 'https://www.notion.so',
  aiURL: 'https://www.notion.so/ai',
};

function getCookieHeader(cookies) {
  return cookies.map(c => `${c.name}=${c.value}`).join('; ');
}

function buildHeaders(accept = 'application/json', referer = UPSTREAM.homeURL, contentType = 'application/json') {
  return {
    'cookie': getCookieHeader(probe.cookies),
    'x-notion-active-user-header': probe.user_id,
    'x-notion-space-id': probe.space_id,
    'notion-client-version': probe.client_version,
    'notion-audit-log-platform': 'web',
    'accept': accept,
    'content-type': contentType,
    'accept-language': 'en-US,en;q=0.9',
    'origin': UPSTREAM.originURL,
    'referer': referer,
    'user-agent': `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${CHROME_VERSION}.0.0.0 Safari/537.36`,
    'sec-ch-ua': `"Google Chrome";v="${CHROME_VERSION}", "Not?A_Brand";v="8", "Chromium";v="${CHROME_VERSION}"`,
    'sec-ch-ua-mobile': '?0',
    'sec-ch-ua-platform': '"Windows"',
    'sec-fetch-dest': 'empty',
    'sec-fetch-mode': 'cors',
    'sec-fetch-site': 'same-origin',
  };
}

async function notionPost(endpoint, body, accept = 'application/json') {
  const url = `https://www.notion.so${endpoint}`;
  const headers = buildHeaders(accept);
  const res = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body) });
  const text = await res.text();
  return { status: res.status, ok: res.ok, contentType: res.headers.get('content-type') || '', body: text };
}

// ============= Step 1: 验证认证 — loadUserContent =============

console.log('\n\n=== Step 1: loadUserContent (验证认证) ===');
const luc = await notionPost('/api/v3/loadUserContent', {});
console.log(`Status: ${luc.status} ${luc.ok ? '✅' : '❌'}`);

if (!luc.ok) {
  console.log(`Response: ${luc.body.slice(0, 500)}`);
  console.error('\n❌ 认证失败 — token_v2 可能已过期');
  process.exit(1);
}

let lucData;
try { lucData = JSON.parse(luc.body); } catch { console.log('⚠️ 响应不是 JSON'); process.exit(1); }

// 提取用户信息
const userKey = Object.keys(lucData.recordMap?.notion_user || {})[0];
const user = lucData.recordMap?.notion_user?.[userKey]?.value;
console.log(`  用户: ${user?.given_name || '?'} ${user?.family_name || ''} (${user?.email || probe.email})`);
console.log(`  用户 ID: ${user?.id || probe.user_id}`);

// 提取空间信息
const spaceKey = Object.keys(lucData.recordMap?.space || {})[0];
const space = lucData.recordMap?.space?.[spaceKey]?.value;
console.log(`  空间: ${space?.name || '?'}`);
console.log(`  空间 ID: ${spaceKey || probe.space_id}`);
console.log(`  空间 View ID: ${Object.keys(lucData.recordMap?.space_view || {})[0] || ''}`);

// 提取 client_version 从响应中
const notionUser = Object.values(lucData.recordMap?.notion_user || {})[0]?.value;
console.log(`  Client Version: ${probe.client_version}`);

// ============= Step 2: 获取可用的 AI 模型 =============

console.log('\n\n=== Step 2: 探测可用 AI 模型 ===');

// Method: Call getSpacesInitial to find space-view and available features
const gsi = await notionPost('/api/v3/getSpacesInitial', {});
console.log(`getSpacesInitial: ${gsi.status}`);

let gsiData;
try { gsiData = JSON.parse(gsi.body); } catch { console.log('⚠️ 响应不是 JSON'); }

if (gsiData) {
  // 尝试从 space 配置中提取可用模型
  const spaces = gsiData[probe.user_id]?.space || {};
  for (const [sid, sdata] of Object.entries(spaces)) {
    if (sid === probe.space_id) {
      const betaFeatures = sdata?.beta_enabled_features || [];
      console.log(`  空间 ${sid} Beta 特性: ${betaFeatures.join(', ') || '无'}`);
      const settings = sdata?.settings || {};
      console.log(`  设置键: ${Object.keys(settings).slice(0, 10).join(', ')}`);
      break;
    }
  }
}

// ============= Step 3: 尝试 getInferenceTranscriptsForUser =============

console.log('\n\n=== Step 3: getInferenceTranscriptsForUser (获取对话列表) ===');
const transcripts = await notionPost('/api/v3/getInferenceTranscriptsForUser', {
  spaceId: probe.space_id,
});
console.log(`Status: ${transcripts.status}`);

// ============= Step 4: 尝试 syncRecordValuesSpaceInitial =============

console.log('\n\n=== Step 4: syncRecordValuesSpaceInitial ===');
const sync = await notionPost('/api/v3/syncRecordValuesSpaceInitial', {
  spaceId: probe.space_id,
  cursor: null,
});
console.log(`Status: ${sync.status}`);

// ============= Step 5: 探测模型列表 =============

console.log('\n\n=== Step 5: 探测 Notion AI 可用模型 ===');

// Try multiple approaches to detect models
// Approach 1: Check space settings for available models
if (gsiData) {
  console.log('\n--- 方法1: 从 getSpacesInitial 设置中查找 ---');
  const mySpaces = gsiData[probe.user_id]?.space || {};
  for (const [sid, sdata] of Object.entries(mySpaces)) {
    if (sid === probe.space_id && sdata?.settings) {
      // 打印所有设置键
      for (const [key, val] of Object.entries(sdata.settings)) {
        console.log(`  setting.${key}: ${typeof val === 'object' ? JSON.stringify(val).slice(0, 200) : val}`);
      }
    }
  }
}

// Approach 2: Common model names used in Notion AI
console.log('\n--- 方法2: 常见 Notion AI 模型 ---');
const knownNotionModels = [
  'claude-sonnet-4-6',
  'claude-opus-4-8',
  'claude-haiku-4-5-20251001',
  'claude-sonnet-4-8',
  'claude-3-5-sonnet',
  'claude-3-opus',
  'claude-3-haiku',
  'gpt-4o',
  'gpt-4o-mini',
  'gpt-4',
  'gpt-3.5-turbo',
  'gemini-pro',
  'gemini-2.0-flash',
];
console.log(`  候选: ${knownNotionModels.join(', ')}`);

// ============= Step 6: 探测 runInferenceTranscript 最小请求体 =============

console.log('\n\n=== Step 6: 测试 runInferenceTranscript 请求体结构 ===');

// 尝试一个最小化请求体 — 先只发空 transactions 看看结构要求
function uuid() { return crypto.randomUUID(); }
function now() { return Date.now(); }

const modelCandidates = knownNotionModels;

for (const candidateModel of modelCandidates.slice(0, 3)) {
  const threadId = uuid();
  const stepUserId = uuid();
  const stepConfigId = uuid();

  const testPayload = {
    id: threadId,
    spaceId: probe.space_id,
    threadId: threadId,
    transactions: [{
      id: uuid(),
      shardId: 1234,
      spaceId: probe.space_id,
      transactions: [{
        type: 'update',
        operations: [
          {
            pointer: { table: 'thread', id: threadId, spaceId: probe.space_id },
            path: [],
            command: 'set',
            args: { type: 'workflow', lastEditedTime: now() }
          },
          {
            pointer: { table: 'thread_view', id: uuid(), spaceId: probe.space_id },
            path: [],
            command: 'set',
            args: { thread_id: threadId, space_id: probe.space_id }
          },
          {
            pointer: { table: 'step', id: stepUserId, spaceId: probe.space_id },
            path: [],
            command: 'set',
            args: {
              type: 'user',
              value: [{ type: 'text', text: 'Say hello world in one sentence.' }],
              id: stepUserId,
              parent_id: threadId,
              parent_table: 'thread',
              created_time: now(),
              last_edited_time: now(),
              aligned_space_id: probe.space_id,
            }
          },
          {
            pointer: { table: 'step', id: stepConfigId, spaceId: probe.space_id },
            path: [],
            command: 'set',
            args: {
              type: 'config',
              value: {
                type: 'workflow',
                model: candidateModel,
              },
              id: stepConfigId,
              parent_id: threadId,
              parent_table: 'thread',
              created_time: now(),
              last_edited_time: now(),
            }
          }
        ]
      }]
    }],
    createThread: true,
    model: candidateModel,
    type: 'workflow',
  };

  console.log(`\n--- 测试模型: ${candidateModel} ---`);
  const result = await notionPost('/api/v3/runInferenceTranscript', testPayload, 'application/x-ndjson');
  console.log(`Status: ${result.status} ${result.ok ? '✅' : '❌'}`);

  if (result.ok) {
    console.log(`✅ 模型 ${candidateModel} 可用!`);
    // 打印前几行 NDJSON
    const lines = result.body.split('\n').filter(l => l.trim());
    console.log(`  收到 ${lines.length} 行 NDJSON`);
    for (const line of lines.slice(0, 5)) {
      try {
        const parsed = JSON.parse(line);
        console.log(`  → ${JSON.stringify(parsed).slice(0, 200)}`);
      } catch {
        console.log(`  → ${line.slice(0, 200)}`);
      }
    }
  } else {
    console.log(`错误响应: ${result.body.slice(0, 500)}`);
  }
}

// ============= 总结 =============
console.log('\n\n=== 总结 ===');
console.log(`认证: ✅ 通过 (${probe.email})`);
console.log(`用户 ID: ${probe.user_id}`);
console.log(`空间 ID: ${probe.space_id}`);
if (space?.name) console.log(`空间名称: ${space.name}`);
console.log('\n✅ 探测完成');