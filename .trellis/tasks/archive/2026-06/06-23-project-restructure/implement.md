# 项目目录重构 - 实施计划

## Implementation Checklist

这是一个分 7 个阶段的渐进式重构计划。每个阶段完成后都要验证功能正常。

---

## Phase 1: 创建新目录结构 ✓

### 任务
- [ ] 创建所有新目录
- [ ] 验证目录结构

### 命令
```bash
cd src
mkdir -p routes channels/deepseek channels/glm channels/gemini
mkdir -p adapters middleware utils services
```

### 验证
```bash
ls -la src/routes src/channels src/adapters src/middleware src/utils src/services
```

### 预期结果
- 所有目录创建成功
- 旧文件保持不变

### 时间估计
5 分钟

---

## Phase 2: 迁移 Utils 层 ✓

### 任务
- [ ] 移动 `chat.js` → `utils/sse.js`
- [ ] 移动 `headers.js` → `utils/headers.js`
- [ ] 移动 `pow.js` → `utils/pow.js`
- [ ] 保持 `model-router.js` 在原位置（已经是 utils 性质）
- [ ] 更新所有导入路径
- [ ] 语法检查

### 文件操作
```bash
cd src
mv chat.js utils/sse.js
mv headers.js utils/headers.js
mv pow.js utils/pow.js
# model-router.js 暂时保持原位，Phase 6 一起迁移
```

### 需要更新导入的文件
- `openai.js`: `import { parseSSEStream } from './chat.js'` → `'./utils/sse.js'`
- `glm.js`: 同上
- `gemini.js`: 同上
- `index.js`: `import { getDispatcher } from './headers.js'` → `'./utils/headers.js'`
- 其他引用 `headers.js` 的文件

### 验证
```bash
node --check src/**/*.js
```

### 时间估计
10-15 分钟

---

## Phase 3: 迁移 Middleware 层 ✓

### 任务
- [ ] 从 `index.js` 提取认证中间件 → `middleware/auth.js`
- [ ] 移动 `logger.js` → `middleware/logger.js`
- [ ] 移动 `metrics.js` → `middleware/metrics.js`
- [ ] 创建 `middleware/error-handler.js`（新增）
- [ ] 更新 `index.js` 导入

### 文件操作
```bash
cd src
mv logger.js middleware/logger.js
mv metrics.js middleware/metrics.js
```

### middleware/auth.js（新建）
从 `index.js` 提取认证逻辑（第 30-40 行）：
```javascript
export function authMiddleware(req, res, next) {
  const apiKey = process.env.API_KEY;
  if (!apiKey) return next();
  if (req.method === 'GET' && (req.path === '/admin' || req.path === '/admin/chat')) return next();

  const auth = req.headers['authorization'];
  if (auth === `Bearer ${apiKey}`) return next();

  res.status(401).json({ error: { message: 'Invalid API key' } });
}
```

### middleware/error-handler.js（新建）
```javascript
export function errorHandler(err, req, res, next) {
  console.error('Error:', err);
  
  res.status(err.status || 500).json({
    error: {
      message: err.message || 'Internal Server Error',
      type: err.type || 'api_error',
    }
  });
}
```

### 更新 index.js
```javascript
import { authMiddleware } from './middleware/auth.js';
import { requestLogger, getRecentLogs, getLogStats, readHistoricalLogs, readChatLogs, listLogDates } from './middleware/logger.js';
import { getMetrics, getTimeseries } from './middleware/metrics.js';
import { errorHandler } from './middleware/error-handler.js';

// 替换原有的内联认证逻辑
app.use(authMiddleware);

// 最后添加错误处理
app.use(errorHandler);
```

### 验证
```bash
node --check src/**/*.js
npm start
curl http://localhost:3000/
```

### 时间估计
15-20 分钟

---

## Phase 4: 迁移 Services 层 ✓

### 任务
- [ ] 移动 `session.js` → `services/session.js`
- [ ] 移动 `conversation.js` → `services/conversation.js`
- [ ] 移动 `queue.js` → `services/queue.js`
- [ ] 移动 `upload.js` → `services/upload.js`
- [ ] 移动 `auth.js` → `services/auth.js`
- [ ] 更新所有导入路径
- [ ] 语法检查

### 文件操作
```bash
cd src
mv session.js services/session.js
mv conversation.js services/conversation.js
mv queue.js services/queue.js
mv upload.js services/upload.js
mv auth.js services/auth.js
```

### 需要更新导入的文件
- `index.js`: 更新所有 service 导入路径
- 其他引用这些服务的文件

### 验证
```bash
node --check src/**/*.js
npm start
curl http://localhost:3000/
```

### 时间估计
15-20 分钟

---

## Phase 5: 迁移 Channels 层 ✓

这是最复杂的阶段，分 3 个子步骤。

### Phase 5.1: 迁移 DeepSeek 渠道

#### 任务
- [ ] 创建 `channels/deepseek/models.js` - 从 `openai.js` 提取 MODEL_MAP
- [ ] 创建 `channels/deepseek/client.js` - API 客户端逻辑（从 `api-client.js`）
- [ ] 创建 `channels/deepseek/handlers.js` - 拆分 `openai.js` 的 handler 逻辑
- [ ] 创建 `channels/deepseek/native.js` - 移动 `deepseek.js` 的内容
- [ ] 创建 `channels/deepseek/index.js` - 导出标准接口
- [ ] 更新导入路径
- [ ] 测试 DeepSeek 端点

#### channels/deepseek/models.js
```javascript
export const DEEPSEEK_MODEL_MAP = {
  'deepseek-v4-flash': {},
  'deepseek-v4-pro': {},
  // ...
};
```

#### channels/deepseek/client.js
从 `api-client.js` 提取 `callDeepSeekAPI` 函数

#### channels/deepseek/handlers.js
从 `openai.js` 提取 `handleOpenAICompletion`, `handleDeepSeekClaude` 函数

#### channels/deepseek/native.js
移动 `deepseek.js` 的全部内容

#### channels/deepseek/index.js
```javascript
import { handleOpenAICompletion, handleDeepSeekClaude } from './handlers.js';
import { handleDeepSeekCompletion } from './native.js';
import { DEEPSEEK_MODEL_MAP } from './models.js';

export default {
  handleOpenAI: handleOpenAICompletion,
  handleClaude: handleDeepSeekClaude,
  handleNative: handleDeepSeekCompletion,
  models: DEEPSEEK_MODEL_MAP,
};
```

#### 验证
```bash
node --check src/channels/deepseek/**/*.js
npm start
# 测试 DeepSeek OpenAI 端点
curl -X POST http://localhost:3000/v1/chat/completions \
  -H "Authorization: Bearer sk-zhi" \
  -d '{"model":"deepseek-v4-flash","messages":[{"role":"user","content":"Hi"}],"max_tokens":10}'
```

#### 时间估计
15-20 分钟

---

### Phase 5.2: 迁移 GLM 渠道

#### 任务
- [ ] 创建 `channels/glm/models.js` - 提取 MODEL_MAP
- [ ] 创建 `channels/glm/token-manager.js` - 提取 Token 管理逻辑
- [ ] 创建 `channels/glm/utils.js` - 提取签名、请求头生成
- [ ] 创建 `channels/glm/client.js` - API 客户端逻辑
- [ ] 创建 `channels/glm/handlers.js` - handler 逻辑
- [ ] 创建 `channels/glm/index.js` - 导出标准接口
- [ ] 更新导入路径
- [ ] 测试 GLM 端点

#### 拆分指南
`glm.js` (1210 行) 拆分为：
- `models.js` (~50 行): MODEL_MAP 定义
- `token-manager.js` (~250 行): GlmTokenManager 类
- `utils.js` (~150 行): 签名生成、请求头生成
- `client.js` (~300 行): API 调用逻辑
- `handlers.js` (~400 行): handleGLMOpenAI, handleGLMClaude
- `index.js` (~60 行): 导出标准接口

#### 验证
```bash
node --check src/channels/glm/**/*.js
npm start
# 测试 GLM OpenAI 端点
curl -X POST http://localhost:3000/v1/chat/completions \
  -H "Authorization: Bearer sk-zhi" \
  -d '{"model":"glm-5.2","messages":[{"role":"user","content":"你好"}],"max_tokens":10}'
```

#### 时间估计
20-25 分钟

---

### Phase 5.3: 迁移 Gemini 渠道

#### 任务
- [ ] 创建 `channels/gemini/models.js`
- [ ] 创建 `channels/gemini/client.js`
- [ ] 创建 `channels/gemini/handlers.js`
- [ ] 创建 `channels/gemini/index.js`
- [ ] 更新导入路径
- [ ] 测试 Gemini 端点（如果配置）

#### 拆分指南
类似 DeepSeek，`gemini.js` (583 行) 拆分为：
- `models.js`
- `client.js`
- `handlers.js`
- `index.js`

#### 验证
```bash
node --check src/channels/gemini/**/*.js
```

#### 时间估计
10-15 分钟

---

## Phase 6: 重构 Routes 层 ✓

### 任务
- [ ] 创建 `routes/api.js` - 提取 API 路由
- [ ] 创建 `routes/admin.js` - 提取 Admin 路由
- [ ] 创建 `routes/legacy.js` - 提取旧版 API 路由
- [ ] 创建 `routes/index.js` - 聚合所有路由
- [ ] 移动 `model-router.js` → `utils/model-router.js`
- [ ] 简化 `index.js` → 考虑拆分为 `app.js` + `server.js`
- [ ] 更新所有导入
- [ ] 全面测试所有端点

### routes/api.js（新建）
```javascript
import express from 'express';
import { routeModel } from '../utils/model-router.js';
import deepseek from '../channels/deepseek/index.js';
import glm from '../channels/glm/index.js';
import gemini from '../channels/gemini/index.js';

const router = express.Router();

// OpenAI 格式 - 统一端点
router.post('/chat/completions', async (req, res, next) => {
  try {
    const { channel } = routeModel(req.body.model);
    
    if (channel === 'deepseek') {
      return await deepseek.handleOpenAI(req, res);
    } else if (channel === 'glm') {
      return await glm.handleOpenAI(req, res);
    } else if (channel === 'gemini') {
      return await gemini.handleOpenAI(req, res);
    }
  } catch (err) {
    return res.status(400).json({
      error: {
        message: err.message,
        type: 'invalid_request_error',
        param: 'model',
        code: 'model_not_found'
      }
    });
  }
});

// Claude 格式 - 统一端点
router.post('/messages', async (req, res, next) => {
  try {
    const { channel } = routeModel(req.body.model);
    
    if (channel === 'deepseek') {
      return await deepseek.handleClaude(req, res);
    } else if (channel === 'glm') {
      return await glm.handleClaude(req, res);
    } else if (channel === 'gemini') {
      return await gemini.handleClaude(req, res);
    }
  } catch (err) {
    return res.status(400).json({
      type: 'error',
      error: {
        type: 'invalid_request_error',
        message: err.message
      }
    });
  }
});

// 模型列表
router.get('/models', (req, res) => {
  const allModels = [
    ...Object.keys(deepseek.models).map(id => ({
      id,
      object: 'model',
      created: 1700000000,
      owned_by: 'deepseek',
    })),
    ...Object.keys(glm.models).map(id => ({
      id,
      object: 'model',
      created: 1700000000,
      owned_by: 'zhipu',
    })),
  ];
  
  res.json({ object: 'list', data: allModels });
});

export default router;
```

### routes/admin.js（新建）
从 `index.js` 提取所有 `/admin/*` 路由

### routes/legacy.js（新建）
```javascript
import express from 'express';
import deepseek from '../channels/deepseek/index.js';

const router = express.Router();

router.post('/chat/completion', deepseek.handleNative);

export default router;
```

### routes/index.js（新建）
```javascript
import express from 'express';
import apiRoutes from './api.js';
import adminRoutes from './admin.js';
import legacyRoutes from './legacy.js';

const router = express.Router();

router.use('/v1', apiRoutes);
router.use('/admin', adminRoutes);
router.use('/api/v0', legacyRoutes);

export default router;
```

### app.js（新建，可选）
从 `index.js` 提取 Express 应用配置：
```javascript
import express from 'express';
import { authMiddleware } from './middleware/auth.js';
import { requestLogger } from './middleware/logger.js';
import { errorHandler } from './middleware/error-handler.js';
import routes from './routes/index.js';

const app = express();

app.use(express.json({ limit: '50mb' }));
app.use(requestLogger('deepseek-2api'));
app.use(authMiddleware);
app.use(routes);

// 健康检查
app.get('/', (req, res) => {
  // ...
});

app.use(errorHandler);

export default app;
```

### server.js（新建，可选）
```javascript
import app from './app.js';

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
```

### 验证
```bash
node --check src/**/*.js
npm start

# 测试所有端点
curl http://localhost:3000/
curl http://localhost:3000/v1/models -H "Authorization: Bearer sk-zhi"
curl -X POST http://localhost:3000/v1/chat/completions -H "Authorization: Bearer sk-zhi" -d '{"model":"deepseek-v4-flash","messages":[{"role":"user","content":"Hi"}]}'
curl -X POST http://localhost:3000/v1/messages -H "Authorization: Bearer sk-zhi" -H "anthropic-version: 2023-06-01" -d '{"model":"glm-5.2","messages":[{"role":"user","content":"你好"}],"max_tokens":100}'
curl http://localhost:3000/admin
```

### 时间估计
25-30 分钟

---

## Phase 7: 清理和优化 ✓

### 任务
- [ ] 删除旧文件（已迁移的）
- [ ] 验证没有遗漏的导入
- [ ] 最终语法检查
- [ ] 全面功能测试
- [ ] 更新 README 文档
- [ ] 创建重构总结文档

### 需要删除的旧文件
```bash
cd src
# 确认这些文件的逻辑都已迁移
rm openai.js deepseek.js glm.js gemini.js  # 已迁移到 channels/
rm auth.js session.js conversation.js queue.js upload.js  # 已迁移到 services/
rm logger.js metrics.js  # 已迁移到 middleware/
rm chat.js headers.js pow.js model-router.js  # 已迁移到 utils/
rm api-client.js  # 逻辑已分散到各 channel 的 client.js

# 如果拆分了 app.js + server.js，删除旧的 index.js
# rm index.js
```

### 验证清单
- [ ] 所有语法检查通过
- [ ] 健康检查端点正常
- [ ] OpenAI 格式端点正常（DeepSeek 和 GLM）
- [ ] Claude 格式端点正常（DeepSeek 和 GLM）
- [ ] 模型列表端点正常
- [ ] 旧版 API 端点正常
- [ ] Admin 面板正常
- [ ] 日志功能正常
- [ ] 指标收集正常
- [ ] 认证功能正常

### 最终验证脚本
```bash
#!/bin/bash

echo "=== 语法检查 ==="
node --check src/**/*.js

echo "=== 启动服务 ==="
npm start &
SERVER_PID=$!
sleep 3

echo "=== 健康检查 ==="
curl -s http://localhost:3000/ | grep "ok"

echo "=== 模型列表 ==="
curl -s http://localhost:3000/v1/models -H "Authorization: Bearer sk-zhi" | grep "deepseek-v4-flash"

echo "=== DeepSeek OpenAI 格式 ==="
curl -s -X POST http://localhost:3000/v1/chat/completions \
  -H "Authorization: Bearer sk-zhi" \
  -d '{"model":"deepseek-v4-flash","messages":[{"role":"user","content":"Hi"}],"max_tokens":5}'

echo "=== GLM Claude 格式 ==="
curl -s -X POST http://localhost:3000/v1/messages \
  -H "Authorization: Bearer sk-zhi" \
  -H "anthropic-version: 2023-06-01" \
  -d '{"model":"glm-5.2","messages":[{"role":"user","content":"你好"}],"max_tokens":5}'

echo "=== 停止服务 ==="
kill $SERVER_PID

echo "=== 所有测试通过！==="
```

### 时间估计
15-20 分钟

---

## Rollback Procedures

### 如果在 Phase N 遇到问题

1. **停止服务**
2. **检查错误日志**
3. **决定回滚或修复**

### 回滚步骤

#### Phase 2-4 回滚
```bash
# 恢复文件到原位置
mv src/utils/sse.js src/chat.js
mv src/utils/headers.js src/headers.js
mv src/utils/pow.js src/pow.js
# ...

# 恢复导入路径（手动或使用备份）
```

#### Phase 5-6 回滚
- 如果有 git：`git checkout .`
- 如果没有 git：使用备份恢复

### 建议
在开始前创建完整备份：
```bash
cp -r src src.backup.$(date +%Y%m%d_%H%M%S)
```

---

## Success Metrics

重构完成后，应该达到：

### 结构指标
- ✅ 所有文件 < 300 行
- ✅ 7 个清晰的目录层级
- ✅ 每个渠道遵循统一结构

### 功能指标
- ✅ 所有现有端点正常工作
- ✅ 响应时间无明显变化
- ✅ 错误率无增加

### 可维护性指标
- ✅ 新增渠道只需 4-5 个文件
- ✅ 修改一个渠道不影响其他渠道
- ✅ 代码可读性显著提升

---

## Estimated Total Time

| Phase | 时间估计 |
|-------|---------|
| Phase 1 | 5 分钟 |
| Phase 2 | 10-15 分钟 |
| Phase 3 | 15-20 分钟 |
| Phase 4 | 15-20 分钟 |
| Phase 5.1 | 15-20 分钟 |
| Phase 5.2 | 20-25 分钟 |
| Phase 5.3 | 10-15 分钟 |
| Phase 6 | 25-30 分钟 |
| Phase 7 | 15-20 分钟 |
| **总计** | **2.5-3 小时** |

---

## Notes

- 每个 Phase 完成后立即测试
- 遇到问题立即停止，不要继续下一个 Phase
- 保持服务可用性，必要时在非高峰时段执行
- Phase 5 是核心，需要格外小心
- 建议分多次会话完成，不要一次性执行所有 Phase
