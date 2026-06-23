/**
 * GLM API 探索脚本 - Phase 2
 * 测试 POST 请求和其他可能性
 */

import crypto from 'crypto';

const GLM_BASE = 'https://chatglm.cn';
const SIGN_SECRET = '8a1317a7468aa3ad86e997d08f3f31cb';

function generateSignature() {
  const now = Date.now().toString();
  const digits = now.split("").map(Number);
  const checksum = (digits.reduce((a, b) => a + b, 0) - digits[digits.length - 2]) % 10;
  const timestamp = now.substring(0, now.length - 2) + checksum + now.substring(now.length - 1);
  const nonce = crypto.randomUUID().replace(/-/g, "");
  const sign = crypto.createHash('md5').update(`${timestamp}-${nonce}-${SIGN_SECRET}`).digest('hex');
  return { timestamp, nonce, sign };
}

function generateHeaders(accessToken = null) {
  const { timestamp, nonce, sign } = generateSignature();
  const headers = {
    'Content-Type': 'application/json;charset=utf-8',
    'App-Name': 'chatglm',
    'X-Device-Id': crypto.randomUUID().replace(/-/g, ""),
    'X-Request-Id': crypto.randomUUID().replace(/-/g, ""),
    'X-App-Platform': 'pc',
    'X-App-Version': '0.0.1',
    'X-Timestamp': timestamp,
    'X-Nonce': nonce,
    'X-Sign': sign,
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
    'Origin': 'https://chatglm.cn',
    'Referer': 'https://chatglm.cn/',
  };
  if (accessToken) headers['Authorization'] = `Bearer ${accessToken}`;
  return headers;
}

async function getGuestToken() {
  const response = await fetch('https://chatglm.cn/chatglm/user-api/guest/access', {
    method: 'POST',
    headers: generateHeaders(),
    body: JSON.stringify({}),
  });
  const data = await response.json();
  return data.status === 0 ? data.result.access_token : null;
}

async function testPOSTEndpoint(path, accessToken, body = {}) {
  const url = `${GLM_BASE}${path}`;
  console.log(`\n   测试 POST: ${path}`);
  console.log(`      请求体: ${JSON.stringify(body)}`);

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: generateHeaders(accessToken),
      body: JSON.stringify(body),
    });

    console.log(`      状态: ${response.status}`);

    if (response.status === 200) {
      const contentType = response.headers.get('content-type');
      if (contentType && contentType.includes('application/json')) {
        const data = await response.json();
        console.log(`      响应:`, JSON.stringify(data, null, 2).substring(0, 1000));
        return { success: true, data };
      }
    } else {
      const text = await response.text();
      console.log(`      错误:`, text.substring(0, 300));
    }
    return { success: false };
  } catch (err) {
    console.error(`      ✗ 错误:`, err.message);
    return { success: false };
  }
}

async function main() {
  console.log('========================================');
  console.log('GLM API Phase 2: POST 请求测试');
  console.log('========================================');

  const accessToken = await getGuestToken();
  console.log(`\n访客 token: ${accessToken ? '✓' : '✗'}`);

  if (!accessToken) return;

  // 测试 assistant/list 的 POST
  await testPOSTEndpoint('/chatglm/backend-api/assistant/list', accessToken, {});
  await new Promise(r => setTimeout(r, 500));

  // 测试其他可能的 POST 端点
  const endpoints = [
    { path: '/chatglm/backend-api/assistant/search', body: { query: '' } },
    { path: '/chatglm/backend-api/assistant/my', body: {} },
    { path: '/chatglm/backend-api/assistant/all', body: {} },
  ];

  for (const { path, body } of endpoints) {
    await testPOSTEndpoint(path, accessToken, body);
    await new Promise(r => setTimeout(r, 500));
  }

  console.log('\n========================================');
}

main().catch(console.error);
