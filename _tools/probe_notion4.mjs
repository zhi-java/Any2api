/**
 * Notion API 深度探测 — 第4轮
 *
 * 1. 正确解析 getSpacesInitial 的 users 结构
 * 2. 搜索 JS chunk 中的 LLM 模型配置
 * 3. 检查用户是否有 Notion AI 订阅
 */

import fs from 'fs';

const PROBE_PATH = './probe.example.json';
const probe = JSON.parse(fs.readFileSync(PROBE_PATH, 'utf-8'));

console.log(`📋 Probe: ${probe.email}\n`);

function getCookieHeader() {
  return probe.cookies.map(c => `${c.name}=${c.value}`).join('; ');
}

async function notionPost(endpoint, body, accept = 'application/json') {
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
  };
  const res = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body) });
  const text = await res.text();
  return { status: res.status, ok: res.ok, body: text };
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

// ============= 1. 正确解析 getSpacesInitial =============

console.log('=== 1. getSpacesInitial — users 结构 ===');
const gsi = await notionPost('/api/v3/getSpacesInitial', {});
if (gsi.ok) {
  const data = JSON.parse(gsi.body);
  const userData = data?.users?.[probe.user_id];
  if (userData) {
    console.log(`✅ 找到用户数据`);
    console.log(`空间数量: ${Object.keys(userData.space || {}).length}`);

    for (const [sid, sdata] of Object.entries(userData.space || {})) {
      const val = sdata?.value || sdata;
      console.log(`\n  空间 ${sid}:`);
      console.log(`    名称: ${val?.name || '?'}`);
      console.log(`    plan: ${val?.plan_type || val?.plan || '?'}`);
      console.log(`    type: ${val?.type || '?'}`);
      console.log(`    version: ${val?.version || '?'}`);

      const betaFeatures = val?.beta_enabled_features || [];
      console.log(`    beta 特性 (${betaFeatures.length}): [${betaFeatures.join(', ')}]`);

      // 打印设置中可能有 AI 相关的
      const settings = val?.settings || {};
      const aiKeys = [];
      for (const [k, v] of Object.entries(settings)) {
        const str = JSON.stringify(v).toLowerCase();
        if (str.includes('model') || str.includes('inference') || str.includes('ai') || str.includes('llm') || str.includes('claude') || str.includes('gpt')) {
          aiKeys.push({ k, v });
        }
      }
      if (aiKeys.length) {
        console.log(`    AI 相关设置:`);
        for (const { k, v } of aiKeys) {
          console.log(`      ${k}: ${typeof v === 'object' ? JSON.stringify(v).slice(0, 300) : v}`);
        }
      }
    }

    // 检查 space_view
    console.log(`\n  space_view 数量: ${Object.keys(userData.space_view || {}).length}`);
    for (const [svid, svdata] of Object.entries(userData.space_view || {})) {
      const sv = svdata?.value || svdata;
      console.log(`    ${svid}: name=${sv?.name || '?'}, space_id=${sv?.space_id || '?'}`);
    }
  } else {
    console.log(`❌ 在 users 中找不到用户 ${probe.user_id}`);
    console.log(`用户 keys: ${Object.keys(data?.users || {}).join(', ')}`);
  }

  // 检查 fanoutData
  console.log(`\n  fanoutData: ${Array.isArray(data.fanoutData) ? `${data.fanoutData.length} items` : typeof data.fanoutData}`);
} else {
  console.log(`❌ getSpacesInitial 失败`);
}

// ============= 2. 搜索 JS chunk — 查找 AI 模型 =============

console.log('\n\n=== 2. JS chunk 深度分析 ===');

// 获取 JS 源码
const jsRes = await notionGet('/_assets/app-2542823ecd6b38c2.js');
if (jsRes.status === 200) {
  const js = jsRes.text;
  console.log(`JS 大小: ${js.length} bytes`);

  // 搜索推理/模型相关的键
  const searchTerms = [
    'inference', 'model', 'LLM', 'llm', 'transcript', 'runInference',
    'createThread', 'saveTransactions', 'spaceId',
    'sonnet', 'opus', 'haiku', 'gpt', 'gemini', 'claude',
    'workflow', 'transaction', 'shardId',
  ];

  for (const term of searchTerms) {
    let count = 0;
    let pos = -1;
    const positions = [];
    while ((pos = js.indexOf(term, pos + 1)) !== -1 && count < 3) {
      positions.push(pos);
      count++;
    }
    if (count > 0) {
      console.log(`\n"${term}": ${count} 处匹配`);
      for (const p of positions.slice(0, 1)) {
        const ctx = js.slice(Math.max(0, p - 60), p + 100);
        console.log(`  位置 ${p}: ${ctx.replace(/\n/g, ' ')}`);
      }
    }
  }

  // 搜索可能的模型列表/对象
  console.log('\n\n--- 搜索 AI 模型名称模式 ---');
  // 查找类似 "models" 或 "availableModels" 或 "modelMap" 的定义
  for (const term of ['availableModels', 'modelMap', 'MODELS', 'AI_MODELS', 'llmModels', 'LLMProvider']) {
    const idx = js.indexOf(term);
    if (idx > -1) {
      console.log(`\n"${term}" 在位置 ${idx}:`);
      console.log(js.slice(idx, idx + 300).replace(/\n/g, ' '));
    }
  }

  // 搜索常见模型名的任何变体
  const patterns = ['claude', 'chatGPT', 'open-ai', 'openai', 'largeLanguageModel'];
  for (const pat of patterns) {
    const idx = js.indexOf(pat);
    if (idx > -1) {
      console.log(`\n"${pat}" 在位置 ${idx}:`);
      console.log(js.slice(Math.max(0, idx - 50), idx + 100).replace(/\n/g, ' '));
    }
  }
}

// ============= 3. 检查用户 AI 状态 =============

console.log('\n\n=== 3. Notion AI 订阅状态 ===');

// 尝试 loadUserContent 二次检查
const luc = await notionPost('/api/v3/loadUserContent', {});
if (luc.ok) {
  const data = JSON.parse(luc.body);
  console.log('recordMap 顶层 key:', Object.keys(data.recordMap || {}).join(', '));

  // team / user 设置
  const nu = Object.values(data.recordMap?.notion_user || {})[0]?.value;
  if (nu) {
    console.log(`\n用户: ${nu.given_name || ''} ${nu.family_name || ''} (${nu.email || ''})`);
    console.log(`用户空间: ${nu.space_ids?.join(', ') || '?'}`);
    console.log(`onboarding_completed: ${nu.onboarding_completed}`);
    // 检查 AI 相关状态
    if (nu.space_ai) console.log(`space_ai: ${JSON.stringify(nu.space_ai)}`);
  }

  // space
  const spaceKey = Object.keys(data.recordMap?.space || {})[0];
  if (spaceKey) {
    const sv = data.recordMap.space[spaceKey]?.value;
    if (sv) {
      console.log(`\n空间: ${sv.name || '?'}`);
      console.log(`plan: ${sv.plan_type || sv.plan || '?'}`);
      console.log(`beta_enabled_features: ${(sv.beta_enabled_features || []).join(', ') || '无'}`);
      console.log(`permissions: ${JSON.stringify(sv.permissions || {}).slice(0, 300)}`);

      // space_view
      const svKey = Object.keys(data.recordMap?.space_view || {})[0];
      if (svKey) {
        const svv = data.recordMap.space_view[svKey]?.value;
        if (svv) {
          console.log(`space_view: ${svv.name || '?'}, type: ${svv.type || '?'}`);
          console.log(`space_view settings: ${JSON.stringify(svv.settings || {}).slice(0, 300)}`);
        }
      }
    }
  }
}

// ============= 4. 直接调用 saveTransactionsFanout 创建测试 thread =============

console.log('\n\n=== 4. 尝试 saveTransactionsFanout 创建 thread ===');
const testId = crypto.randomUUID();
const stfPayload = {
  transactions: [{
    id: crypto.randomUUID(),
    shardId: 1234,
    spaceId: probe.space_id,
    transactions: [{
      type: 'update',
      operations: [{
        pointer: { table: 'thread', id: testId, spaceId: probe.space_id },
        path: [],
        command: 'set',
        args: { type: 'workflow' }
      }]
    }]
  }]
};
const stf = await notionPost('/api/v3/saveTransactionsFanout', stfPayload);
console.log(`Status: ${stf.status} ${stf.ok ? '✅' : '❌'}`);
if (stf.ok) console.log(`成功: ${stf.body.slice(0, 200)}`);
else console.log(`失败: ${stf.body.slice(0, 300)}`);

console.log('\n✅ 探测完成');