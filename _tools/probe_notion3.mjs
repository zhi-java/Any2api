/**
 * Notion API 深度探测 — 第3轮
 *
 * 1. 检查 getSpacesInitial 的顶层结构
 * 2. 搜索 JS chunk 获取真正的 API 格式
 * 3. 用发现的格式构造请求
 */

import fs from 'fs';

const PROBE_PATH = './probe.example.json';
const probe = JSON.parse(fs.readFileSync(PROBE_PATH, 'utf-8'));

console.log(`📋 Probe: ${probe.email}\n`);

function getCookieHeader() {
  return probe.cookies.map(c => `${c.name}=${c.value}`).join('; ');
}

async function notionGet(endpoint) {
  const res = await fetch(`https://www.notion.so${endpoint}`, {
    headers: {
      'cookie': getCookieHeader(),
      'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/145.0.0.0 Safari/537.36',
    }
  });
  return { status: res.status, text: await res.text() };
}

async function notionPost(endpoint, body, accept = 'application/json', extraHeaders = {}) {
  const url = `https://www.notion.so${endpoint}`;
  const headers = {
    'cookie': getCookieHeader(),
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

// ============= 1. 检查 getSpacesInitial 结构 =============

console.log('=== 1. getSpacesInitial 顶层结构 ===');
const gsiResult = await notionPost('/api/v3/getSpacesInitial', {});
if (gsiResult.ok) {
  const data = JSON.parse(gsiResult.body);
  console.log(`类型: ${typeof data}, 顶层 key: ${Object.keys(data).join(', ')}`);

  // 检查用户 key
  for (const [key, val] of Object.entries(data)) {
    if (typeof val === 'object' && val !== null) {
      console.log(`\n[${key}] 类型=${Array.isArray(val) ? 'array' : 'object'}, keys=${Object.keys(val).join(', ').slice(0, 200)}`);
      // Check if this looks like user data
      if (val.space || val.space_view) {
        console.log(`  ✅ 找到 space/space_view 数据!`);

        const spaces = val.space || {};
        const spaceViews = val.space_view || {};
        console.log(`  space keys: ${Object.keys(spaces).slice(0, 5).join(', ')}`);
        console.log(`  space_view keys: ${Object.keys(spaceViews).slice(0, 5).join(', ')}`);

        for (const [sk, sv] of Object.entries(spaces)) {
          console.log(`\n  space[${sk.slice(0, 20)}...]:`);
          console.log(`    value:`, JSON.stringify(sv?.value).slice(0, 300));
          if (sv?.value?.beta_enabled_features) {
            console.log(`    beta: ${sv.value.beta_enabled_features.join(', ')}`);
          }
          if (sv?.value?.settings) {
            const settings = sv.value.settings;
            console.log(`    settings: ${Object.keys(settings).length} 个键`);
            for (const [sk2, sv2] of Object.entries(settings)) {
              console.log(`      ${sk2}: ${typeof sv2 === 'object' ? JSON.stringify(sv2).slice(0, 200) : sv2}`);
            }
          }
        }
      }
    }
  }
} else {
  console.log(`❌ getSpacesInitial 失败: ${gsiResult.status}`);
  console.log(gsiResult.body.slice(0, 300));
}

// ============= 2. 分析 Notion JS chunk =============

console.log('\n\n=== 2. JS 代码分析 ===');
const jsRes = await notionGet('/_assets/app-2542823ecd6b38c2.js');
if (jsRes.status === 200) {
  const js = jsRes.text;

  // 搜索 runInferenceTranscript
  const inferenceIdx = js.indexOf('runInferenceTranscript');
  if (inferenceIdx > -1) {
    console.log('✅ 找到 runInferenceTranscript');
    // 提取上下文（找附近的 JSON/对象结构）
    console.log('\n--- 上下文 (前500字符) ---');
    console.log(js.slice(Math.max(0, inferenceIdx - 300), inferenceIdx + 200));
    console.log('\n--- 上下文 (后500字符) ---');
    console.log(js.slice(inferenceIdx, inferenceIdx + 500));
  }

  // 搜索 "model" 相关的配置
  console.log('\n\n--- 搜索模型配置 ---');
  const modelConfigs = [];
  let searchIdx = 0;
  while (true) {
    const idx = js.indexOf('claude-sonnet', searchIdx);
    if (idx === -1) break;
    modelConfigs.push(idx);
    searchIdx = idx + 1;
    if (modelConfigs.length > 5) break;
  }
  if (modelConfigs.length) {
    for (const idx of modelConfigs) {
      console.log(`\nFound at offset ${idx}:`);
      console.log(js.slice(Math.max(0, idx - 100), idx + 150));
    }
  }

  // 搜索所有模型相关
  for (const term of ['claude-opus', 'claude-haiku', 'gpt-4o', 'gemini']) {
    const idx = js.indexOf(term);
    if (idx > -1) {
      console.log(`\n--- "${term}" found at ${idx} ---`);
      console.log(js.slice(Math.max(0, idx - 80), idx + 120));
    }
  }

  // 搜索 saveTransactionsFanout 上下文
  const saveIdx = js.indexOf('saveTransactionsFanout');
  if (saveIdx > -1) {
    console.log('\n\n--- saveTransactionsFanout 上下文 ---');
    console.log(js.slice(Math.max(0, saveIdx - 200), saveIdx + 300));
  }

  // 搜索 "threadId" 和 "createThread" 上下文
  for (const term of ['threadId', 'createThread', 'spaceId']) {
    const idx = js.indexOf(`"${term}"`);
    if (idx > -1) {
      console.log(`\n--- "${term}" found at ${idx} ---`);
      console.log(js.slice(Math.max(0, idx - 100), idx + 200));
    }
  }

  // 搜索 NDJSON / content-type
  const ndjsonIdx = js.indexOf('x-ndjson');
  if (ndjsonIdx > -1) {
    console.log('\n\n--- x-ndjson 上下文 ---');
    console.log(js.slice(Math.max(0, ndjsonIdx - 100), ndjsonIdx + 100));
  }
} else {
  console.log(`❌ 无法获取 JS chunk: ${jsRes.status}`);
}

// ============= 3. 尝试从 Notion /ai 页面获取模型信息 =============

console.log('\n\n=== 3. Notion /ai 页面 ===');
const aiRes = await notionGet('/ai');
if (aiRes.status === 200) {
  const html = aiRes.text;
  // 查找 API 端点信息
  const apiEndpoints = html.match(/\/api\/v3\/[\w]+/g) || [];
  console.log('页面中的 API 端点:', [...new Set(apiEndpoints)]);

  // 找 __NEXT_DATA__ 或类似的内联 JSON
  const nextDataMatch = html.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
  if (nextDataMatch) {
    try {
      const nextData = JSON.parse(nextDataMatch[1]);
      console.log('\n__NEXT_DATA__ 顶层 key:', Object.keys(nextData).join(', '));
      if (nextData.props?.pageProps) {
        console.log('pageProps:', JSON.stringify(nextData.props.pageProps).slice(0, 500));
      }
    } catch {}
  }
}

// ============= 4. 直接请求测试 — 尝试不同的 content-type =============

console.log('\n\n=== 4. 直接 curl 测试 ===');

// 真正的 Notion AI 请求的 content-type 是什么样的？
// 从文档看："application/x-ndjson" 用于流式请求
// 但也许请求体本身是 JSON，接受的才是 x-ndjson?
const tid = crypto.randomUUID();
const testPayload = {
  id: tid,
  spaceId: probe.space_id,
  threadId: tid,
  transactions: [],
  createThread: true,
  model: 'claude-sonnet-4-6',
  type: 'workflow',
};

console.log('\n--- 测试4a: 空 transactions ---');
const r4a = await notionPost('/api/v3/runInferenceTranscript', testPayload, 'application/x-ndjson');
console.log(`  Status: ${r4a.status}`);
if (!r4a.ok) console.log(`  ${r4a.body.slice(0, 400)}`);

console.log('\n--- 测试4b: content-type = application/x-ndjson ---');
const r4b = await notionPost('/api/v3/runInferenceTranscript', testPayload, 'application/x-ndjson', { 'content-type': 'application/x-ndjson' });
console.log(`  Status: ${r4b.status}`);
if (!r4b.ok) console.log(`  ${r4b.body.slice(0, 400)}`);

// 测试: 真正发送 NDJSON 格式的 body（每行一个 JSON）
console.log('\n--- 测试4c: 真正的 NDJSON body (每行一个 JSON) ---');
{
  const url = 'https://www.notion.so/api/v3/runInferenceTranscript';
  const headers = {
    'cookie': getCookieHeader(),
    'x-notion-active-user-header': probe.user_id,
    'x-notion-space-id': probe.space_id,
    'notion-client-version': probe.client_version,
    'notion-audit-log-platform': 'web',
    'accept': 'application/x-ndjson',
    'content-type': 'text/plain',
    'accept-language': 'en-US,en;q=0.9',
    'origin': 'https://www.notion.so',
    'referer': 'https://www.notion.so/ai',
    'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/145.0.0.0 Safari/537.36',
  };
  // 尝试 body 为 NDJSON 而不是 JSON
  const body = JSON.stringify({
    id: tid,
    spaceId: probe.space_id,
    threadId: tid,
    transactions: [{
      id: crypto.randomUUID(),
      shardId: 1234,
      spaceId: probe.space_id,
      transactions: [{
        type: 'update',
        operations: [{
          pointer: { table: 'thread', id: tid, spaceId: probe.space_id },
          path: [],
          command: 'set',
          args: { type: 'workflow' }
        }]
      }]
    }],
    createThread: true,
    model: 'claude-sonnet-4-6',
    type: 'workflow',
  });
  // 把每个 transaction 变成单独一行
  // 实际上还是完整的 JSON
  const res = await fetch(url, { method: 'POST', headers, body });
  const text = await res.text();
  console.log(`  Status: ${res.status} ${res.ok ? '✅' : '❌'}`);
  if (!res.ok) console.log(`  ${text.slice(0, 400)}`);
}

// ============= 5. 验证 — 用 loadUserContent 检查 AI 功能状态 =============

console.log('\n\n=== 5. loadUserContent — 检查 AI 功能 ===');
const luc = await notionPost('/api/v3/loadUserContent', {});
if (luc.ok) {
  const data = JSON.parse(luc.body);
  const spaceKey = Object.keys(data.recordMap?.space || {})[0];
  if (spaceKey) {
    const spaceVal = data.recordMap.space[spaceKey]?.value;
    if (spaceVal) {
      console.log(`空间名称: ${spaceVal.name || '?'}`);
      console.log(`空间 plan: ${spaceVal.plan_type || spaceVal.plan || '?'}`);

      // 检查 AI 相关功能
      const features = spaceVal.beta_enabled_features || [];
      const aiFeatures = features.filter(f => f.toLowerCase().includes('ai'));
      console.log(`AI 相关特性: ${aiFeatures.length ? aiFeatures.join(', ') : '无'}`);
      console.log(`所有 beta 特性: ${features.join(', ')}`);

      // 检查空间设置
      const settings = spaceVal.settings || {};
      const aiSettings = {};
      for (const [k, v] of Object.entries(settings)) {
        if (k.toLowerCase().includes('ai') || String(v).toLowerCase().includes('ai')) {
          aiSettings[k] = v;
        }
      }
      if (Object.keys(aiSettings).length) {
        console.log('AI 相关设置:', JSON.stringify(aiSettings, null, 2));
      }

      console.log(`空间类型: ${spaceVal.type || '?'}`);
      console.log(`空间版本: ${spaceVal.version || '?'}`);
    }
  }
}

console.log('\n✅ 探测完成');