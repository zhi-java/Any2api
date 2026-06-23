# 项目目录重构 - 技术设计

## Architecture Overview

### 目标架构（轻量级模块化）

```
src/
├── app.js                    # Express 应用配置（中间件、错误处理）
├── server.js                 # 服务器启动入口
│
├── routes/                   # 路由层：定义 API 端点
│   ├── index.js             # 主路由（聚合所有路由）
│   ├── api.js               # API 路由（/v1/*）
│   ├── admin.js             # Admin 路由（/admin/*）
│   └── legacy.js            # 旧版 API（/api/v0/*）
│
├── channels/                 # 渠道实现：每个 AI 服务商一个目录
│   ├── deepseek/
│   │   ├── index.js         # 主入口（导出标准接口）
│   │   ├── handlers.js      # Express 请求处理器
│   │   ├── client.js        # API 客户端
│   │   └── models.js        # 模型配置
│   ├── glm/
│   │   ├── index.js
│   │   ├── handlers.js
│   │   ├── client.js
│   │   ├── models.js
│   │   ├── token-manager.js # Token 管理（GLM 特有）
│   │   └── utils.js         # GLM 工具（签名、请求头）
│   └── gemini/
│       ├── index.js
│       ├── handlers.js
│       ├── client.js
│       └── models.js
│
├── adapters/                 # 格式适配器：API 格式转换
│   ├── openai.js            # OpenAI 格式（通用）
│   ├── claude.js            # Claude 格式
│   └── gemini.js            # Gemini 格式
│
├── middleware/               # Express 中间件
│   ├── auth.js              # API Key 认证
│   ├── logger.js            # 请求日志
│   ├── error-handler.js     # 统一错误处理
│   └── metrics.js           # 指标收集
│
├── utils/                    # 通用工具函数
│   ├── model-router.js      # 模型路由器
│   ├── sse.js               # SSE 流解析
│   ├── headers.js           # 请求头工具
│   └── pow.js               # PoW 工作量证明
│
├── services/                 # 业务服务（跨渠道的通用服务）
│   ├── session.js           # 会话管理
│   ├── conversation.js      # 对话管理
│   ├── queue.js             # 请求队列
│   └── upload.js            # 文件上传
│
└── config/                   # 配置管理（可选，暂不实施）
    └── index.js
```

---

## Layer Responsibilities

### 1. Routes 层（路由定义）

**职责**：定义 API 端点，路由到对应的处理器

**文件**：
- `routes/api.js`：定义 `/v1/*` 端点
- `routes/admin.js`：定义 `/admin/*` 端点
- `routes/legacy.js`：定义 `/api/v0/*` 端点

**不应该包含**：
- ❌ 业务逻辑
- ❌ 数据处理
- ❌ 格式转换

**示例**：
```javascript
// routes/api.js
import express from 'express';
import { routeModel } from '../utils/model-router.js';
import deepseek from '../channels/deepseek/index.js';
import glm from '../channels/glm/index.js';

const router = express.Router();

router.post('/chat/completions', async (req, res) => {
  const { channel } = routeModel(req.body.model);
  
  if (channel === 'deepseek') {
    return deepseek.handleOpenAI(req, res);
  } else if (channel === 'glm') {
    return glm.handleOpenAI(req, res);
  }
});

router.post('/messages', async (req, res) => {
  const { channel } = routeModel(req.body.model);
  
  if (channel === 'deepseek') {
    return deepseek.handleClaude(req, res);
  } else if (channel === 'glm') {
    return glm.handleClaude(req, res);
  }
});

export default router;
```

---

### 2. Channels 层（渠道实现）

**职责**：封装每个 AI 服务商的完整实现

**标准接口**（每个渠道都必须实现）：
```javascript
// channels/<channel>/index.js
export default {
  // OpenAI 格式处理
  handleOpenAI: async (req, res) => { ... },
  
  // Claude 格式处理
  handleClaude: async (req, res) => { ... },
  
  // 原生格式处理（可选）
  handleNative: async (req, res) => { ... },
  
  // 模型列表
  models: MODEL_MAP,
};
```

#### 渠道内部文件职责

**index.js** (20-30 行)：
- 导出标准接口
- 聚合其他模块

**handlers.js** (100-150 行)：
- Express 请求处理逻辑
- 调用 adapter 进行格式转换
- 调用 client 进行 API 请求
- 处理流式/非流式分支
- 错误处理

**client.js** (150-200 行)：
- 底层 API 调用
- HTTP 请求构建
- 认证处理
- 重试逻辑
- 响应解析

**models.js** (30-50 行)：
- 模型配置（MODEL_MAP）
- 模型元数据

**utils.js** (可选，50-100 行)：
- 渠道特定的辅助函数
- 例如：GLM 的签名生成、请求头构建

---

### 3. Adapters 层（格式适配）

**职责**：API 格式之间的转换（与渠道无关）

**文件**：
- `adapters/openai.js`：OpenAI ↔ 标准格式
- `adapters/claude.js`：Claude ↔ OpenAI
- `adapters/gemini.js`：Gemini ↔ OpenAI

**关键点**：
- Adapter 不知道底层渠道是谁
- Adapter 只做格式转换，不做 API 调用

**示例**：
```javascript
// adapters/claude.js
export function convertClaudeRequest(claudeReq) {
  // Claude → OpenAI 格式
  return openaiReq;
}

export function convertOpenAIResponse(openaiResp, model) {
  // OpenAI → Claude 格式
  return claudeResp;
}

export async function* streamOpenAIToClaude(openaiStream, model) {
  // OpenAI SSE → Claude SSE
  yield* claudeEvents;
}
```

---

### 4. Middleware 层（中间件）

**职责**：Express 中间件（认证、日志、错误处理）

**文件**：
- `middleware/auth.js`：API Key 认证
- `middleware/logger.js`：请求日志
- `middleware/error-handler.js`：统一错误处理
- `middleware/metrics.js`：指标收集

**示例**：
```javascript
// middleware/auth.js
export function authMiddleware(req, res, next) {
  const apiKey = process.env.API_KEY;
  if (!apiKey) return next();
  
  const auth = req.headers['authorization'];
  if (auth === `Bearer ${apiKey}`) return next();
  
  res.status(401).json({ error: { message: 'Invalid API key' } });
}
```

---

### 5. Utils 层（工具函数）

**职责**：通用的纯函数工具

**文件**：
- `utils/model-router.js`：模型路由器
- `utils/sse.js`：SSE 流解析
- `utils/headers.js`：请求头工具
- `utils/pow.js`：PoW 工作量证明

**特点**：
- 纯函数，无副作用
- 与业务逻辑解耦
- 可独立测试

---

### 6. Services 层（业务服务）

**职责**：跨渠道的通用业务逻辑

**文件**：
- `services/session.js`：会话管理
- `services/conversation.js`：对话管理
- `services/queue.js`：请求队列
- `services/upload.js`：文件上传

**说明**：
- 这些服务不属于特定渠道
- 是跨渠道共享的基础设施

---

## Data Flow

### OpenAI 格式请求流程

```
Client
  ↓ POST /v1/chat/completions
routes/api.js
  ↓ 路由分发
middleware/auth.js
  ↓ 认证
middleware/logger.js
  ↓ 日志
utils/model-router.js
  ↓ 识别渠道
channels/deepseek/handlers.js
  ↓ 请求处理
channels/deepseek/client.js
  ↓ API 调用
  ← DeepSeek API
channels/deepseek/handlers.js
  ↓ 响应处理
Client
```

### Claude 格式请求流程

```
Client
  ↓ POST /v1/messages
routes/api.js
  ↓ 路由分发
middleware/auth.js
  ↓ 认证
middleware/logger.js
  ↓ 日志
utils/model-router.js
  ↓ 识别渠道
channels/glm/handlers.js
  ↓ 请求处理
adapters/claude.js
  ↓ Claude → OpenAI 转换
channels/glm/client.js
  ↓ API 调用
  ← GLM API
channels/glm/client.js
  ↓ 响应解析
adapters/claude.js
  ↓ OpenAI → Claude 转换
Client
```

---

## Migration Strategy

### Phase 1: 创建新目录结构

**步骤**：
1. 创建所有新目录
2. 不移动任何文件
3. 验证目录结构

**时间**: 5 分钟

---

### Phase 2: 迁移 Utils 层

**步骤**：
1. 移动 `chat.js` → `utils/sse.js`
2. 移动 `headers.js` → `utils/headers.js`
3. 移动 `pow.js` → `utils/pow.js`
4. 移动 `model-router.js` → `utils/model-router.js`
5. 更新所有导入路径
6. 语法检查

**时间**: 10-15 分钟

**风险**: 低（工具函数无状态）

---

### Phase 3: 迁移 Middleware 层

**步骤**：
1. 从 `index.js` 提取认证逻辑 → `middleware/auth.js`
2. 移动 `logger.js` → `middleware/logger.js`
3. 移动 `metrics.js` → `middleware/metrics.js`
4. 创建 `middleware/error-handler.js`（新增）
5. 更新 `index.js` 导入
6. 验证中间件功能

**时间**: 15-20 分钟

**风险**: 低（中间件相对独立）

---

### Phase 4: 迁移 Services 层

**步骤**：
1. 移动 `session.js` → `services/session.js`
2. 移动 `conversation.js` → `services/conversation.js`
3. 移动 `queue.js` → `services/queue.js`
4. 移动 `upload.js` → `services/upload.js`
5. 移动 `auth.js` → `services/auth.js`（Token 池管理）
6. 更新所有导入路径
7. 语法检查

**时间**: 15-20 分钟

**风险**: 中（有状态服务，需要仔细测试）

---

### Phase 5: 迁移 Channels 层（最复杂）

**子步骤 5.1: 迁移 DeepSeek 渠道**
1. 创建 `channels/deepseek/` 目录
2. 拆分 `openai.js`：
   - `models.js` - 模型配置
   - `client.js` - API 客户端逻辑
   - `handlers.js` - Express handler
   - `index.js` - 导出接口
3. 拆分 `deepseek.js` → `handlers.js`（原生格式）
4. 更新导入路径
5. 验证 DeepSeek 端点

**子步骤 5.2: 迁移 GLM 渠道**
1. 创建 `channels/glm/` 目录
2. 拆分 `glm.js`：
   - `models.js` - 模型配置
   - `token-manager.js` - Token 管理
   - `utils.js` - 签名、请求头
   - `client.js` - API 客户端
   - `handlers.js` - Express handler
   - `index.js` - 导出接口
3. 更新导入路径
4. 验证 GLM 端点

**子步骤 5.3: 迁移 Gemini 渠道**
1. 创建 `channels/gemini/` 目录
2. 拆分 `gemini.js`（类似 DeepSeek）
3. 验证 Gemini 端点

**时间**: 30-45 分钟（每个渠道 10-15 分钟）

**风险**: 高（核心业务逻辑，需要仔细拆分和测试）

---

### Phase 6: 重构 Routes 层

**步骤**：
1. 创建 `routes/api.js`（从 `index.js` 提取 API 路由）
2. 创建 `routes/admin.js`（提取 Admin 路由）
3. 创建 `routes/legacy.js`（提取旧版 API）
4. 创建 `routes/index.js`（聚合所有路由）
5. 简化 `index.js` → 只保留 app 配置和启动逻辑
6. 考虑拆分为 `app.js` + `server.js`
7. 验证所有路由

**时间**: 20-30 分钟

**风险**: 中（路由是入口，需要确保所有端点正常）

---

### Phase 7: 清理和优化

**步骤**：
1. 删除旧文件
2. 更新所有注释和文档
3. 最终语法检查
4. 全面功能测试
5. 性能验证

**时间**: 15-20 分钟

**风险**: 低

---

## Rollback Plan

每个 Phase 都可以独立回滚：

1. **Phase 1-2**: 直接删除新文件，恢复原状
2. **Phase 3-6**: 使用 git（如果有）或备份恢复
3. **关键检查点**: 每个 Phase 结束后运行语法检查和基本功能测试

---

## Testing Strategy

### 验证清单（每个 Phase 后）

#### 语法验证
```bash
node --check src/**/*.js
```

#### 基本功能测试
```bash
# 启动服务
npm start

# 测试健康检查
curl http://localhost:3000/

# 测试 OpenAI 格式（DeepSeek）
curl -X POST http://localhost:3000/v1/chat/completions \
  -H "Authorization: Bearer sk-xxx" \
  -d '{"model":"deepseek-v4-flash","messages":[{"role":"user","content":"Hi"}]}'

# 测试 Claude 格式（GLM）
curl -X POST http://localhost:3000/v1/messages \
  -H "Authorization: Bearer sk-xxx" \
  -H "anthropic-version: 2023-06-01" \
  -d '{"model":"glm-5.2","messages":[{"role":"user","content":"你好"}],"max_tokens":100}'

# 测试模型列表
curl http://localhost:3000/v1/models -H "Authorization: Bearer sk-xxx"
```

---

## Risk Assessment

| Phase | Risk Level | Mitigation |
|-------|-----------|-----------|
| Phase 1 | 低 | 只创建目录，无风险 |
| Phase 2 | 低 | Utils 是纯函数，易于回滚 |
| Phase 3 | 低-中 | Middleware 相对独立 |
| Phase 4 | 中 | Services 有状态，需仔细测试 |
| Phase 5 | 高 | 核心逻辑，分渠道迁移降低风险 |
| Phase 6 | 中 | 路由是入口，需全面测试 |
| Phase 7 | 低 | 清理阶段，可随时停止 |

---

## Dependencies

### 外部依赖（不变）
- Express
- dotenv
- node:crypto

### 内部依赖变化

**旧的依赖链**：
```
index.js
  → openai.js, glm.js, gemini.js
    → auth.js, logger.js, chat.js, headers.js
```

**新的依赖链**：
```
server.js
  → app.js
    → routes/index.js
      → routes/api.js, routes/admin.js
        → channels/deepseek/, channels/glm/
          → adapters/*, services/*, utils/*
            → middleware/*
```

---

## Post-Migration Benefits

### 可扩展性
**新增渠道步骤**：
1. 在 `channels/` 创建新目录
2. 实现标准接口（index.js, handlers.js, client.js, models.js）
3. 在 `utils/model-router.js` 添加路由规则
4. 在 `routes/api.js` 添加分发逻辑

**估计时间**: 1-2 小时（vs 当前 3-4 小时）

### 可维护性
- 文件大小合理（< 200 行）
- 职责清晰
- 易于定位问题

### 可测试性
- 每个模块可独立测试
- 纯函数易于单元测试
- 集成测试更清晰

---

## Success Criteria

- [ ] 所有文件 < 300 行
- [ ] 目录结构清晰，职责分明
- [ ] 所有现有功能正常工作
- [ ] 新增渠道步骤清晰且简单
- [ ] 代码可读性和可维护性显著提升
