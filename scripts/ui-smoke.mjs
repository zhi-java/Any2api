#!/usr/bin/env node
/**
 * 无头浏览器 UI 冒烟验证（开发期工具，不参与运行时）。
 *
 * 启动 headless Chrome，登录管理后台，依次渲染各 hash 路由页面，
 * 收集 console 错误与页面异常，并对可疑页面截图。
 *
 * 用法：node scripts/ui-smoke.mjs [baseUrl] [apiKey]
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';

const BASE = process.argv[2] || 'http://localhost:3995';
const API_KEY = process.argv[3] || 'sk-verify-key';
const PORT = 9222;

const CHROME_CANDIDATES = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
];
const chromePath = CHROME_CANDIDATES.find(p => existsSync(p));
if (!chromePath) {
  console.error('未找到 Chrome，跳过 UI 冒烟');
  process.exit(0);
}

const chrome = spawn(
  chromePath,
  [
    '--headless=new',
    '--disable-gpu',
    '--no-sandbox',
    '--no-first-run',
    `--remote-debugging-port=${PORT}`,
    '--user-data-dir=' + (process.env.TEMP || '/tmp') + '/omni-ui-smoke',
    'about:blank',
  ],
  { stdio: 'ignore' },
);

async function httpJson(path) {
  const res = await fetch(`http://127.0.0.1:${PORT}${path}`);
  return res.json();
}

async function waitForPageTarget() {
  for (let i = 0; i < 60; i++) {
    try {
      const targets = await httpJson('/json/list');
      const page = targets.find(t => t.type === 'page' && t.webSocketDebuggerUrl);
      if (page) return page;
    } catch {
      // 未就绪，继续等
    }
    await sleep(300);
  }
  throw new Error('DevTools 页面 target 未就绪');
}

class CDP {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    this.events = [];
    ws.addEventListener('message', ev => {
      const msg = JSON.parse(ev.data);
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result);
      } else if (msg.method) {
        this.events.push(msg);
      }
    });
  }
  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
}

async function connect(wsUrl) {
  const ws = new WebSocket(wsUrl);
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once: true });
    ws.addEventListener('error', reject, { once: true });
  });
  return new CDP(ws);
}

async function evaluate(cdp, expression) {
  const result = await cdp.send('Runtime.evaluate', {
    expression,
    awaitPromise: true,
    returnByValue: true,
  });
  if (result.exceptionDetails) {
    throw new Error(result.exceptionDetails.text || 'eval 异常');
  }
  return result.result.value;
}

const ROUTES = ['dashboard', 'channels', 'credentials', 'apiKeys', 'settings', 'logs', 'performance'];

try {
  const pageTarget = await waitForPageTarget();
  const cdp = await connect(pageTarget.webSocketDebuggerUrl);

  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  await cdp.send('Log.enable');

  await cdp.send('Page.navigate', { url: `${BASE}/admin` });
  await sleep(2500);

  // 登录
  const loggedIn = await evaluate(
    cdp,
    `(async () => {
      const r = await fetch('/admin/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ apiKey: ${JSON.stringify(API_KEY)} }),
      });
      return r.status;
    })()`,
  );
  console.log(`登录 -> HTTP ${loggedIn}`);

  // 真正重载页面：仅改 hash 不触发重新挂载，鉴权状态不会重查。
  await cdp.send('Page.reload', { ignoreCache: true });
  await sleep(2500);

  // 确认已进入控制台外壳（而非仍停在登录页）
  const shell = await evaluate(cdp, `(() => {
    const nav = document.querySelector('nav[aria-label="主导航"]');
    return { hasShell: Boolean(nav), text: (document.body.innerText || '').slice(0, 60) };
  })()`);
  if (!shell.hasShell) {
    console.error(`登录后未进入控制台，仍显示: "${shell.text.replace(/\s+/g, ' ')}"`);
    chrome.kill();
    process.exit(1);
  }

  let failures = 0;
  for (const route of ROUTES) {
    cdp.events.length = 0;
    await evaluate(cdp, `location.hash = '#${route}'`);
    await sleep(1800);

    const snapshot = await evaluate(
      cdp,
      `(() => {
        const main = document.querySelector('main') || document.body;
        const text = (main.innerText || '').trim();
        return {
          length: text.length,
          head: text.slice(0, 90).replace(/\\s+/g, ' '),
          hasErrorBoundary: /Something went wrong|Uncaught|无法读取/.test(text),
        };
      })()`,
    );

    const consoleErrors = cdp.events
      .filter(e => e.method === 'Runtime.consoleAPICalled' && e.params.type === 'error')
      .map(e => e.params.args.map(a => a.value ?? a.description ?? '').join(' '));
    const exceptions = cdp.events
      .filter(e => e.method === 'Runtime.exceptionThrown')
      .map(e => e.params.exceptionDetails?.text || 'exception');
    const errors = [...consoleErrors, ...exceptions];

    // 判定标准：无 console/运行时错误，且主体渲染出了页面专属内容
    // （空态页面文本天然较短，因此只看是否超出登录页残留长度）。
    const ok = !snapshot.hasErrorBoundary && errors.length === 0 && snapshot.length > 60;
    if (!ok) failures++;
    console.log(
      `${ok ? 'PASS' : 'FAIL'} #${route}  text=${snapshot.length}B  "${snapshot.head}"${
        errors.length ? `\n     errors: ${errors.join(' | ')}` : ''
      }`,
    );
  }

  console.log(failures === 0 ? '\n全部页面渲染通过' : `\n${failures} 个页面存在问题`);
  chrome.kill();
  process.exit(failures === 0 ? 0 : 1);
} catch (error) {
  console.error('UI 冒烟失败:', error.message);
  chrome.kill();
  process.exit(1);
}
