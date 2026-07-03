import { loadEnvironment } from './utils/env.js';
loadEnvironment();

import express from 'express';
import {
  initTokenPool,
  getPoolInfo,
  getTotalCapacity,
  getAliveTokens,
  startHealthCheck,
  stopHealthCheck,
} from './services/auth.js';
import { prewarmSessions } from './services/session.js';
import { getQueueInfo } from './services/queue.js';
import { requestLogger } from './middleware/logger.js';
import { getDispatcher } from './utils/headers.js';
import { setupUnhandledRejectionHandler } from './utils/response-utils.js';
import routes from './routes/index.js';

setupUnhandledRejectionHandler();

export function createApp() {
  const app = express();

  app.use(express.json({ limit: '50mb' }));
  app.use(requestLogger('zhi2api'));

  app.get('/', (req, res) => {
    res.json({
      status: 'ok',
      version: '1.0.0',
      pool: getPoolInfo(),
      totalCapacity: getTotalCapacity(),
      queue: getQueueInfo(),
    });
  });

  app.use((req, res, next) => {
    const apiKey = process.env.API_KEY;
    if (!apiKey) return next();

    if (req.path.startsWith('/admin') && !req.path.startsWith('/admin/api')) {
      return next();
    }

    if (req.path.startsWith('/performance') && !req.path.startsWith('/performance/api')) {
      return next();
    }

    if (req.path.startsWith('/admin/api') || req.path.startsWith('/performance/api')) {
      const auth = req.headers['authorization'];
      if (auth === `Bearer ${apiKey}`) return next();
      return res.status(401).json({ error: { message: 'Invalid API key' } });
    }

    next();
  });

  app.use(routes);

  return app;
}

async function initializeRuntime() {
  await getDispatcher();
  await initTokenPool();

  const aliveTokens = getAliveTokens();
  await prewarmSessions(aliveTokens);

  startHealthCheck();
}

function logStartup(port) {
  console.log(`zhi2Api running on http://localhost:${port}`);
  console.log('\nAPI Endpoints:');
  console.log('  Health:       GET  /');
  console.log('  OpenAI:       POST /v1/chat/completions');
  console.log('  Claude:       POST /v1/messages');
  console.log('  Models:       GET  /v1/models');
  console.log('  DeepSeek native: POST /api/v0/chat/completion');
  console.log(`\nAdmin Panel:    http://localhost:${port}/admin`);
  console.log(`Performance:    http://localhost:${port}/performance`);

  if (!process.env.API_KEY) {
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
    const onListening = async () => {
      const address = server.address();
      const actualPort = typeof address === 'object' && address ? address.port : port;

      try {
        if (startupLogs) logStartup(actualPort);
        await initializeRuntime();

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
      } catch (error) {
        stopHealthCheck();
        server.close(() => reject(error));
      }
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
