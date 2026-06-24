import { config } from 'dotenv';
config();

import express from 'express';
import { initTokenPool, getPoolInfo, getTotalCapacity, getAliveTokens, startHealthCheck } from './services/auth.js';
import { prewarmSessions } from './services/session.js';
import { getQueueInfo } from './services/queue.js';
import { requestLogger } from './middleware/logger.js';
import { getDispatcher } from './utils/headers.js';
import { setupUnhandledRejectionHandler } from './utils/response-utils.js';
import routes from './routes/index.js';

setupUnhandledRejectionHandler();

const app = express();
const PORT = process.env.PORT || 3000;

// ============= 中间件配置 =============

app.use(express.json({ limit: '50mb' }));

// Request logging (writes to /srv/threadripper-backups/newapi/logs/deepseek-2api/)
app.use(requestLogger('deepseek-2api'));

// ============= 健康检查端点（认证前） =============

app.get('/', (req, res) => {
  res.json({
    status: 'ok',
    version: '2.0.0',
    pool: getPoolInfo(),
    totalCapacity: getTotalCapacity(),
    queue: getQueueInfo(),
  });
});

// ============= API Key auth middleware =============

app.use((req, res, next) => {
  const apiKey = process.env.API_KEY;
  if (!apiKey) return next();

  // 豁免 /admin 下的静态资源（HTML、CSS、JS、图片等）
  if (req.path.startsWith('/admin') && !req.path.startsWith('/admin/api')) {
    return next();
  }

  // 豁免 /performance 下的静态资源
  if (req.path.startsWith('/performance') && !req.path.startsWith('/performance/api')) {
    return next();
  }

  // 只对 /admin/api 和 /performance/api 进行我们的 API Key 认证
  if (req.path.startsWith('/admin/api') || req.path.startsWith('/performance/api')) {
    const auth = req.headers['authorization'];
    if (auth === `Bearer ${apiKey}`) return next();
    return res.status(401).json({ error: { message: 'Invalid API key' } });
  }

  // 其他路径（如 /v1/*）不受此认证影响，由各自的路由处理
  next();
});

// ============= 所有路由 =============

app.use(routes);

// ============= 启动服务器 =============

app.listen(PORT, async () => {
  console.log(`DeepSeek 2API running on http://localhost:${PORT}`);
  console.log(`\nAPI Endpoints:`);
  console.log(`  Health:       GET  /`);
  console.log(`  OpenAI:       POST /v1/chat/completions`);
  console.log(`  Claude:       POST /v1/messages`);
  console.log(`  Models:       GET  /v1/models`);
  console.log(`  DeepSeek native: POST /api/v0/chat/completion`);
  console.log(`\nAdmin Panel:    http://localhost:${PORT}/admin`);
  console.log(`Performance:    http://localhost:${PORT}/performance`);

  if (!process.env.API_KEY) {
    console.warn('\n⚠️  WARNING: API_KEY is not set — admin endpoints (/admin/api/*, /performance/api/*) are UNAUTHENTICATED.\n' +
      '   Set API_KEY in .env before exposing this service on a public network.\n');
  }

  await getDispatcher();
  await initTokenPool();

  const aliveTokens = getAliveTokens();
  await prewarmSessions(aliveTokens);

  startHealthCheck();

  // ============= Notion 渠道初始化 =============

  const notionProbePath = process.env.NOTION_PROBE_PATH;
  if (notionProbePath) {
    try {
      const { loadSession } = await import('./channels/notion/session.js');
      const session = loadSession(notionProbePath);
      console.log(`Notion channel ready: ${session.email} (${session.userName})`);
    } catch (err) {
      console.warn(`\n⚠️  Notion channel UNAVAILABLE: ${err.message}\n`);
    }
  } else {
    console.log('Notion channel: disabled (set NOTION_PROBE_PATH to enable)');
  }
});
