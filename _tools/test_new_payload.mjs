/**
 * 使用 Go 项目正确的请求体格式测试 runInferenceTranscript
 */

import fs from 'fs';
import crypto from 'crypto';

const probe = JSON.parse(fs.readFileSync('./probe.example.json', 'utf-8'));
const cookie = probe.cookies.map(c => `${c.name}=${c.value}`).join('; ');

function uuid() { return crypto.randomUUID(); }
function isoNow() {
  return new Date().toISOString().replace(/\.\d+Z$/, '+08:00').replace('Z', '+08:00');
}

const headers = {
  'cookie': cookie,
  'x-notion-active-user-header': probe.user_id,
  'x-notion-space-id': probe.space_id,
  'notion-client-version': probe.client_version,
  'notion-audit-log-platform': 'web',
  'accept': 'application/x-ndjson',
  'content-type': 'application/json',
  'accept-language': 'en-US,en;q=0.9',
  'origin': 'https://www.notion.so',
  'referer': 'https://www.notion.so/ai',
  'user-agent': 'Mozilla/5.0 Chrome/145.0.0.0 Safari/537.36',
  'sec-ch-ua': '"Google Chrome";v="145", "Not?A_Brand";v="8", "Chromium";v="145"',
  'sec-ch-ua-mobile': '?0',
  'sec-ch-ua-platform': '"Windows"',
  'sec-fetch-dest': 'empty',
  'sec-fetch-mode': 'cors',
  'sec-fetch-site': 'same-origin',
};

// 测试多个模型
const models = [
  { public: 'claude-sonnet-4-6', internal: 'almond-croissant-low' },
  { public: 'claude-haiku-4-5', internal: 'anthropic-haiku-4-5' },
  { public: 'gemini-2.5-flash', internal: 'vertex-gemini-2.5-flash' },
];

for (const { public: pub, internal: model } of models) {
  const tid = uuid();
  const configId = uuid();
  const contextId = uuid();
  const now = isoNow();

  const payload = {
    spaceId: probe.space_id,
    threadId: tid,
    createThread: true,
    generateTitle: true,
    traceId: uuid(),
    transcript: [
      {
        id: configId,
        type: 'config',
        value: {
          type: 'workflow',
          model,
          enableAgentAutomations: true,
          enableAgentIntegrations: true,
          enableCustomAgents: true,
          enableScriptAgent: true,
          enableCreateAndRunThread: true,
          enableScriptAgentSlack: true,
          enableScriptAgentMail: true,
          enableScriptAgentCalendar: true,
          enableAgentGenerateImage: false,
          useWebSearch: false,
          searchScopes: [],
          useReadOnlyMode: false,
          writerMode: false,
          modelFromUser: true,
          isCustomAgent: false,
        },
      },
      {
        id: contextId,
        type: 'context',
        value: {
          timezone: 'Asia/Shanghai',
          userName: 'du junmeng',
          userId: probe.user_id,
          userEmail: probe.email,
          spaceName: "fency's Space",
          spaceId: probe.space_id,
          currentDatetime: now,
          surface: 'ai_module',
        },
      },
      {
        id: uuid(),
        type: 'user',
        value: [['Say hello in one sentence.']],
        userId: probe.user_id,
        createdAt: now,
      },
    ],
    threadType: 'workflow',
    asPatchResponse: true,
    isPartialTranscript: false,
    saveAllThreadOperations: true,
    setUnreadState: true,
    createdSource: 'ai_module',
    isUserInAnySalesAssistedSpace: false,
    isSpaceSalesAssisted: false,
    debugOverrides: {
      annotationInferences: {},
      cachedInferences: {},
      emitAgentSearchExtractedResults: true,
      emitInferences: false,
    },
    threadParentPointer: {
      table: 'space',
      id: probe.space_id,
      spaceId: probe.space_id,
    },
  };

  console.log(`\n=== 测试模型: ${pub} (→ ${model}) ===`);
  console.log(`请求体大小: ${JSON.stringify(payload).length} bytes`);

  const resp = await fetch('https://www.notion.so/api/v3/runInferenceTranscript', {
    method: 'POST',
    headers,
    body: JSON.stringify(payload),
  });

  if (resp.ok) {
    console.log(`✅ 状态: ${resp.status}`);
    console.log('--- 前 20 行 NDJSON ---');
    const reader = resp.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let lineCount = 0;

    while (lineCount < 20) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';
      for (const line of lines) {
        if (!line.trim()) continue;
        lineCount++;
        const clip = line.length > 200 ? line.slice(0, 200) + '...' : line;
        console.log(`  [${lineCount}] ${clip}`);
      }
    }
    reader.cancel();

    if (lineCount > 0) {
      console.log(`\n✅ 成功收到 ${lineCount}+ 行 NDJSON`);
      break;
    }
  } else {
    const text = await resp.text();
    console.log(`❌ 状态: ${resp.status}`);
    console.log(`   ${text.slice(0, 400)}`);
  }
}

console.log('\n✅ 测试完成');