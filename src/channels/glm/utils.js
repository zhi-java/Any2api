/**
 * GLM 工具函数
 *
 * 签名生成、请求头构建等 GLM 特定工具
 */

import crypto from 'node:crypto';

const SIGN_SECRET = '8a1317a7468aa3ad86e997d08f3f31cb';

/**
 * 生成带校验位的时间戳
 * GLM 要求时间戳最后一位为校验和
 */
export function makeTimestamp() {
  const now = Date.now().toString();
  const digits = now.split('').map(Number);
  const checksum = (digits.reduce((a, b) => a + b, 0) - digits[digits.length - 2]) % 10;
  return now.substring(0, now.length - 2) + checksum + now.substring(now.length - 1);
}

/**
 * 生成随机 nonce (32位十六进制)
 */
export function makeNonce() {
  return crypto.randomUUID().replace(/-/g, '');
}

/**
 * 生成请求签名
 * @param {string} timestamp - 时间戳
 * @param {string} nonce - 随机数
 * @returns {string} MD5 签名
 */
export function makeSign(timestamp, nonce) {
  return crypto.createHash('md5').update(`${timestamp}-${nonce}-${SIGN_SECRET}`).digest('hex');
}

/**
 * 生成 UUID (不含连字符)
 */
export function makeUuid() {
  return crypto.randomUUID().replace(/-/g, '');
}

/**
 * 生成 GLM 认证请求头
 * @param {string} timestamp - 时间戳
 * @param {string} nonce - 随机数
 * @param {string} sign - 签名
 * @returns {object} 请求头对象
 */
export function makeAuthHeaders(timestamp, nonce, sign) {
  return {
    'Content-Type': 'application/json;charset=utf-8',
    'App-Name': 'chatglm',
    'X-Device-Id': makeUuid(),
    'X-Request-Id': makeUuid(),
    'X-App-Platform': 'pc',
    'X-App-Version': '0.0.1',
    'X-App-fr': 'browser',
    'X-Lang': 'zh-CN',
    'X-Exp-Groups': '',
    'X-Device-Model': '',
    'X-Device-Brand': '',
    'X-Timestamp': timestamp,
    'X-Nonce': nonce,
    'X-Sign': sign,
  };
}

/**
 * 生成 GLM API 请求头
 * @param {string} accessToken - 访问令牌
 * @returns {object} 请求头对象
 */
export function generateGLMHeaders(accessToken = '') {
  const headers = {
    'Content-Type': 'application/json',
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
    'Origin': 'https://chatglm.cn',
    'Referer': 'https://chatglm.cn/',
    'X-Request-Id': makeUuid(),
  };

  if (accessToken) {
    headers['Authorization'] = `Bearer ${accessToken}`;
  }

  return headers;
}
