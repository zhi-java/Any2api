/**
 * GLM API 探索脚本
 *
 * 测试可能的模型列表 API 端点
 */

import crypto from 'crypto';

// GLM API 基础配置
const GLM_BASE = 'https://chatglm.cn';
const SIGN_SECRET = '8a1317a7468aa3ad86e997d08f3f31cb';

// 生成签名
function generateSignature() {
  const now = Date.now().toString();
  const digits = now.split("").map(Number);
  const checksum = (digits.reduce((a, b) => a + b, 0) - digits[digits.length - 2]) % 10;
  const timestamp = now.substring(0, now.length - 2) + checksum + now.substring(now.length - 1);
  const nonce = crypto.randomUUID().replace(/-/g, "");
  const sign = crypto.createHash('md5').update(`${timestamp}-${nonce}-${SIGN_SECRET}`).digest('hex');

  return { timestamp, nonce, sign };
}

// 生成请求头
function generateHeaders(accessToken = null) {
  const { timestamp, nonce, sign } = generateSignature();
  const deviceId = crypto.randomUUID().replace(/-/g, "");
  const requestId = crypto.randomUUID().replace(/-/g, "");

  const headers = {
    'Content-Type': 'application/json;charset=utf-8',
    'App-Name': 'chatglm',
    'X-Device-Id': deviceId,
    'X-Request-Id': requestId,
    'X-App-Platform': 'pc',
    'X-App-Version': '0.0.1',
    'X-App-fr': 'browser',
    'X-Lang': 'zh-CN',
    'X-Timestamp': timestamp,
    'X-Nonce': nonce,
    'X-Sign': sign,
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
    'Origin': 'https://chatglm.cn',
    'Referer': 'https://chatglm.cn/',
  };

  if (accessToken) {
    headers['Authorization'] = `Bearer ${accessToken}`;
  }

  return headers;
}

// 获取访客 token
async function getGuestToken() {
  console.log('\n[1] 获取访客 token...');

  try {
    const response = await fetch('https://chatglm.cn/chatglm/user-api/guest/access', {
      method: 'POST',
      headers: generateHeaders(),
      body: JSON.stringify({}),
    });

    const data = await response.json();
    console.log('   状态:', response.status);
    console.log('   响应:', JSON.stringify(data, null, 2));

    if (data.status === 0 && data.result) {
      console.log('   ✓ 访客 token 获取成功');
      return data.result.access_token;
    }

    console.log('   ✗ 访客 token 获取失败');
    return null;
  } catch (err) {
    console.error('   ✗ 错误:', err.message);
    return null;
  }
}

// 测试可能的模型列表端点
async function testEndpoint(path, accessToken) {
  const url = `${GLM_BASE}${path}`;
  console.log(`\n   测试: ${path}`);

  try {
    const response = await fetch(url, {
      method: 'GET',
      headers: generateHeaders(accessToken),
    });

    console.log(`      状态: ${response.status}`);

    if (response.status === 200) {
      const contentType = response.headers.get('content-type');
      console.log(`      Content-Type: ${contentType}`);

      if (contentType && contentType.includes('application/json')) {
        const data = await response.json();
        console.log(`      响应:`, JSON.stringify(data, null, 2).substring(0, 500));
        return { success: true, data };
      } else {
        const text = await response.text();
        console.log(`      响应（非JSON）:`, text.substring(0, 200));
      }
    } else if (response.status === 404) {
      console.log(`      ✗ 404 Not Found`);
    } else if (response.status === 401) {
      console.log(`      ✗ 401 Unauthorized`);
    } else if (response.status === 403) {
      console.log(`      ✗ 403 Forbidden`);
    } else {
      const text = await response.text();
      console.log(`      错误响应:`, text.substring(0, 200));
    }

    return { success: false };
  } catch (err) {
    console.error(`      ✗ 请求失败:`, err.message);
    return { success: false };
  }
}

// 主函数
async function main() {
  console.log('========================================');
  console.log('GLM API 模型列表端点探索');
  console.log('========================================');

  // 1. 获取访客 token
  const accessToken = await getGuestToken();

  if (!accessToken) {
    console.log('\n无法获取访客 token，部分测试可能失败');
  }

  // 2. 测试可能的端点
  console.log('\n[2] 测试可能的模型列表端点...');

  const endpoints = [
    '/chatglm/backend-api/assistant/list',
    '/chatglm/backend-api/assistants',
    '/chatglm/backend-api/models',
    '/chatglm/user-api/models',
    '/chatglm/backend-api/v1/models',
    '/chatglm/api/models',
    '/chatglm/backend-api/assistant/models',
    '/chatglm/backend-api/model/list',
  ];

  const results = [];

  for (const endpoint of endpoints) {
    const result = await testEndpoint(endpoint, accessToken);
    results.push({ endpoint, ...result });
    await new Promise(resolve => setTimeout(resolve, 500)); // 避免请求过快
  }

  // 3. 总结
  console.log('\n========================================');
  console.log('探索结果总结');
  console.log('========================================');

  const successful = results.filter(r => r.success);

  if (successful.length > 0) {
    console.log('\n✓ 找到可用的端点:');
    successful.forEach(r => {
      console.log(`  - ${r.endpoint}`);
    });
  } else {
    console.log('\n✗ 未找到可用的模型列表端点');
    console.log('\n建议方案:');
    console.log('  1. 保持硬编码的 MODEL_MAP');
    console.log('  2. 创建手动更新脚本');
    console.log('  3. 定期检查 GLM 官方文档更新');
  }
}

// 运行
main().catch(console.error);
