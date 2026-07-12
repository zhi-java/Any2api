import { loadEnvironment } from './utils/env.js';
loadEnvironment();

import express from 'express';
import { srcPath } from './utils/runtime-paths.js';
import {
  initTokenPool,
  getAliveTokens,
  startHealthCheck,
  stopHealthCheck,
} from './services/auth.js';
import { prewarmSessions } from './services/session.js';
import { requestLogger } from './middleware/logger.js';
import { getDispatcher } from './utils/headers.js';
import { setupUnhandledRejectionHandler } from './utils/response-utils.js';
import { getConfig, getAcceptedApiKeys, isAcceptedApiKey } from './services/config-store.js';
import { getAdminApiKey, hasValidAdminAuth } from './services/admin-auth.js';
import routes from './routes/index.js';

setupUnhandledRejectionHandler();

function wantsHtml(req) {
  return String(req.headers.accept || '').includes('text/html') || !String(req.headers.accept || '').includes('application/json');
}

export function createApp() {
  const app = express();

  app.use(express.json({
    limit: '50mb',
    verify: (req, _res, buf) => {
      req.rawBody = Buffer.from(buf);
    },
  }));
  app.use(requestLogger('omni'));

  app.get('/healthz', (_req, res) => {
    res.json({
      status: 'ok',
      version: '1.0.0',
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
}

export async function startServer(options = {}) {
  const {
    port = process.env.PORT || 3000,
    host,
    startupLogs = true,
  } = options;

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
