const BROWSER_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36',
  'Accept-Language': 'zh-CN,zh;q=0.9',
  'Sec-CH-UA': '"Chromium";v="148", "Google Chrome";v="148", "Not/A)Brand";v="99"',
  'Sec-CH-UA-Mobile': '?0',
  'Sec-CH-UA-Platform': '"Windows"',
  'Sec-Fetch-Dest': 'empty',
  'Sec-Fetch-Mode': 'cors',
  'Sec-Fetch-Site': 'same-origin',
  Origin: 'https://chat.qwen.ai',
  source: 'web',
  Version: '0.2.68',
  'bx-v': '2.5.36',
};

function requestId() {
  return crypto.randomUUID();
}

function timezoneHeader() {
  return new Date().toString().replace(/\s*\(.+\)$/, '');
}

export function requestHeaders(extra = {}) {
  return {
    'Content-Type': 'application/json',
    Accept: 'application/json, text/plain, */*',
    'X-Request-Id': requestId(),
    Timezone: timezoneHeader(),
    ...BROWSER_HEADERS,
    ...extra,
  };
}

export function chatHeaders(token, chatId, extra = {}) {
  return {
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
    Accept: 'application/json',
    'X-Accel-Buffering': 'no',
    'X-Request-Id': requestId(),
    Timezone: timezoneHeader(),
    Referer: `https://chat.qwen.ai/c/${chatId}`,
    ...BROWSER_HEADERS,
    ...extra,
  };
}
