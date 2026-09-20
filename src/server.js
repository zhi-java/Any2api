import { loadEnvironment } from './utils/env.js';
loadEnvironment();

import express from 'express';
import v8 from 'node:v8';
import { appVersion, srcPath } from './utils/runtime-paths.js';
import {
  initTokenPool,
  getAliveTokens,
  startHealthCheck,
  stopHealthCheck,
} from './services/auth.js';
import { prewarmSessions } from './services/session.js';
import { requestLogger, pruneDebugLogs } from './middleware/logger.js';
import { getDispatcher } from './utils/headers.js';
import { setupUnhandledRejectionHandler } from './utils/response-utils.js';
import { getConfig, getAcceptedApiKeys, isAcceptedApiKey } from './services/config-store.js';
import { getAdminApiKey, hasValidAdminAuth } from './services/admin-auth.js';
import routes from './routes/index.js';

setupUnhandledRejectionHandler();

function wantsHtml(req) {
  return String(req.headers.accept || '').includes('text/html') || !String(req.headers.accept || '').includes('application/json');
}

// 请求体大小上限。
//
// 原值 50mb 是低配服务器上的内存隐患：express 会先把整个 body 读进内存，
// 而 rawBody 又要再留一份（见下），两者相乘再乘并发数。实测客户端最大
// payload 约 2.28MB（Claude Code 全量上下文），故默认降至 25mb 留足余量，
// 可用 MAX_REQUEST_BODY_MB 覆盖。
function maxRequestBodyBytes() {
  const mb = parseInt(process.env.MAX_REQUEST_BODY_MB || '25', 10);
  return (Number.isFinite(mb) && mb > 0 ? mb : 25) * 1024 * 1024;
}

export function createApp() {
  const app = express();

  app.use(express.json({
    limit: maxRequestBodyBytes(),
    // 直接引用 express 传入的 buf，不再 Buffer.from(buf) 复制一份。
    // 该 buf 在解析后不会被复用，保留引用是安全的；而复制会让每个请求
    // 在内存里多出一份与请求体等大的副本（大 prompt 下可达数 MB）。
    // 保留 rawBody 是功能需要：关闭提示词注入时用它作为上游 prompt
    // （见 response-utils.js 的 getRawJsonPromptForRequest）。
    verify: (req, _res, buf) => {
      req.rawBody = buf;
    },
  }));
  app.use(requestLogger('omni'));

  app.get('/healthz', (_req, res) => {
    res.json({
      status: 'ok',
      version: appVersion(),
    });
  });

  app.get('/', (_req, res) => {
    res.sendFile(srcPath('public', 'index.html'));
  });

  app.use((req, res, next) => {
    const apiKey = getAdminApiKey();
    if (!apiKey) return next();

    if (req.path === '/admin/api/auth/status' || req.path === '/admin/api/auth/login' || req.path === '/admin/api/auth/logout') {
      return next();
    }

    if (req.path.startsWith('/admin/api') || req.path.startsWith('/performance/api')) {
      if (hasValidAdminAuth(req)) return next();
      return res.status(401).json({ error: { message: 'Invalid API key' } });
    }

    next();
  });

  app.use((req, res, next) => {
    if (!req.path.startsWith('/v1')) return next();
    if (getAcceptedApiKeys().length === 0) return next();

    // 兼容三种认证方式：
    // 1. Authorization: Bearer <key>
    // 2. api-key: <key>
    // 3. x-api-key: <key>
    const auth = req.headers?.authorization || '';
    const apiKeyHdr = req.headers?.['api-key'] || '';
    const xApiKeyHdr = req.headers?.['x-api-key'] || '';
    const token = (auth.startsWith('Bearer ') ? auth.slice(7).trim() : '')
      || apiKeyHdr.trim()
      || xApiKeyHdr.trim();
    if (token && isAcceptedApiKey(token)) return next();

    return res.status(401).json({
      error: {
        message: 'Invalid API key',
        type: 'invalid_request_error',
        code: 'invalid_api_key',
      },
    });
  });

  app.use(routes);

  app.get('*', (req, res) => {
    if (req.path.startsWith('/v1') || req.path.startsWith('/admin/api') || req.path.startsWith('/performance/api')) {
      return res.status(404).json({ error: { message: 'Not found' } });
    }
    if (wantsHtml(req)) return res.sendFile(srcPath('public', 'index.html'));
    return res.status(404).json({ error: { message: 'Not found' } });
  });

  return app;
}

async function initializeRuntime() {
  const config = getConfig();
  await getDispatcher();
  await initTokenPool();

  if (config.deepseek.prewarmSessions) {
    const aliveTokens = getAliveTokens();
    await prewarmSessions(aliveTokens);
  } else {
    console.log('Session prewarm skipped (enable from admin settings if needed).');
  }

  startHealthCheck();
}

function logStartup(port) {
  console.log(`OmniAPI running on http://localhost:${port}`);
  console.log('\nAPI Endpoints:');
  console.log('  Health:       GET  /healthz');
  console.log('  OpenAI:       POST /v1/chat/completions');
  console.log('  Claude:       POST /v1/messages');
  console.log('  Responses:    POST /v1/responses');
  console.log('  Models:       GET  /v1/models');
  console.log(`\nAdmin Panel:    http://localhost:${port}/admin`);
  console.log(`Performance:    http://localhost:${port}/performance`);

  if (!getAdminApiKey()) {
    console.warn('\nWARNING: API_KEY is not set - admin endpoints (/admin/api/*, /performance/api/*) are UNAUTHENTICATED.\n' +
      '   Set API_KEY in .env before exposing this service on a public network.\n');
  }

  // 内存与限制可见性：低配部署下需要能一眼确认护栏是否生效。
  const heapMb = Math.round(process.memoryUsage().heapTotal / 1024 / 1024);
  const heapLimitMb = Math.round(v8.getHeapStatistics().heap_size_limit / 1024 / 1024);
  console.log(`Memory:   heap ${heapMb}MB used / ${heapLimitMb}MB limit (raise with NODE_OPTIONS=--max-old-space-size=<MB>)`);
  console.log(
    `Limits:   request body ${process.env.MAX_REQUEST_BODY_MB || 25}MB`
    + ` | response capture ${Math.round((parseInt(process.env.LOG_RESPONSE_CAPTURE_MAX_CHARS || '262144', 10) || 262144) / 1024)}KB`
    + ` | debug log ${process.env.CLIENT_DEBUG_LOG === 'true' ? 'ON' : 'OFF'}`,
  );
}

export async function startServer(options = {}) {
  const {
    port = process.env.PORT || 3000,
    host,
    startupLogs = true,
  } = options;

  // 清理过期调试日志：长期开启调试日志会持续占盘（实测单日 37MB）。
  // 放在构建 app 之前执行，失败也不影响启动。
  try { pruneDebugLogs(); } catch { /* 清理失败不应阻断启动 */ }

  const app = createApp();

  return await new Promise((resolve, reject) => {
    const onListening = () => {
      const address = server.address();
      const actualPort = typeof address === 'object' && address ? address.port : port;
      const actualHost = host || '0.0.0.0';

      if (startupLogs) logStartup(actualPort);

      resolve({
        app,
        server,
        port: actualPort,
        host: host || 'localhost',
        close: () => new Promise((closeResolve, closeReject) => {
          stopHealthCheck();
          server.close(err => (err ? closeReject(err) : closeResolve()));
        }),
      });

      initializeRuntime().catch(error => {
        console.error('Runtime initialization failed:', error);
      });
    };

    const onError = error => {
      reject(error);
    };

    const server = host
      ? app.listen(port, host, onListening)
      : app.listen(port, onListening);

    server.once('error', onError);
    server.once('listening', () => server.off('error', onError));
  });
}
