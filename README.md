# Any2API — 多模型协议桥

> 将各大模型 Web 聊天接口封装为 OpenAI / Anthropic 标准 API，统一工具调用，智能 Token 管理。

[![Node.js](https://img.shields.io/badge/Node.js-22+-339933?logo=node.js)](https://nodejs.org)
[![Express](https://img.shields.io/badge/Express-4.21+-000?logo=express)](https://expressjs.com)
[![License](https://img.shields.io/badge/License-MIT-blue)](#license)

---

## 目录

- [Why Any2API?](#why-any2api)
- [架构总览](#架构总览)
- [快速开始](#快速开始)
- [API 端点](#api-端点)
  - [OpenAI 兼容 — `/v1/chat/completions`](#openai-兼容---v1chatcompletions)
  - [Anthropic 兼容 — `/v1/messages`](#anthropic-兼容---v1messages)
  - [原生 DeepSeek — `/api/v0/chat/completion`](#原生-deepseek---apiv0chatcompletion)
  - [模型列表 — `/v1/models`](#模型列表---v1models)
- [工具调用（Tool Calling）](#工具调用tool-calling)
- [Token 池与负载均衡](#token-池与负载均衡)
- [会话亲和（Conversation Affinity）](#会话亲和conversation-affinity)
- [配置参考](#配置参考)
- [管理面板](#管理面板)
- [性能监控](#性能监控)
- [渠道支持](#渠道支持)
- [高可用设计](#高可用设计)
- [开发指南](#开发指南)
- [常见问题](#常见问题)

---

## Why Any2API?

| 问题 | Any2API 方案 |
|------|-------------|
| DeepSeek 只有 Web Chat，没有官方 API | 用账号池模拟 API，支持 OAI/Anthropic 双协议 |
| 多账号频繁被 Ban | 账号池 + 健康检查 + 自动剔除死账号 |
| 对话历史每次都要重发 | 服务端会话亲和，按轮次续接 |
| PoW 算力证明阻塞客户端 | 内置 WebAssembly PoW 求解器 |
| 工具调用不直观 | `<tool_calls>` XML 注入 + `tool_choice` 校验流水线 |
| 弱模型乱输出工具名 | 白名单校验 + 参数消毒，杜绝幻觉 |

---

## 架构总览

```
                       ┌─────────────────────────────┐
  ┌──────────┐         │         Any2API              │
  │ Claude   │ ◄──────►│  ┌───────────────────────┐   │
  │ Code     │ POST    │  │  claude-response.js    │   │
  │ / Client │ /v1/ch  │  │  ← Anthropic 格式输出  │   │
  │          │ at/com  │  └───────────────────────┘   │
  │ OpenAI   │ pletion │  ┌───────────────────────┐   │
  │ SDK      │ ◄──────►│  │  openai-response.js   │   │
  │          │ POST    │  │  ← OpenAI 格式输出     │   │
  │ Python   │ /v1/me  │  └───────────────────────┘   │
  │ Bridge   │ ssages  │         │                     │
  └──────────┘         │    ┌────┴────┐               │
                       │    │ Model   │               │
                       │    │ Router  │               │
                       │    └────┬────┘               │
                       │    ┌────┴────┐               │
                       │    │ Service │               │
                       │    │  Layer  │               │
                       │    ├─ auth.js    (Token池)   │
                       │    ├─ session.js (会话管理)  │
                       │    ├─ queue.js   (请求队列)  │
                       │    ├─ conversation.js (续接)│
                       │    ├─ upload.js  (图片上传) │
                       │    └─ sse.js     (SSE 流)   │
                       │         │                     │
                       │    ┌────┴──────────┐         │
                       │    │  Channels      │         │
                       │    ├─ deepseek/     │         │
                       │    │  ├ handlers.js │         │
                       │    │  ├ client.js   │         │
                       │    │  ├ models.js   │         │
                       │    │  └ native.js   │         │
                       │    ├─ glm/          │         │
                       │    │  ├ handlers.js │         │
                       │    │  ├ client.js   │         │
                       │    │  ├ models.js   │         │
                       │    │  ├ stream-par..│         │
                       │    │  ├ token-man.. │         │
                       │    │  └ utils.js    │         │
                       │    └─────┬──────────┘         │
                       └─────────┼─────────────────────┘
                                 │
                    ┌────────────┴────────────┐
                    │  DeepSeek Web Chat       │
                    │  或 GLM/智谱清言 Web     │
                    │  (通过账号池访问)         │
                    └─────────────────────────┘
```

### 核心数据流

```
请求 → 协议适配层 (OpenAI / Anthropic)
    → 模型路由 (deepseek-* / glm-*)
    → 服务层 (Token分配 → 会话管理 → 队列)
    → 渠道 Handler (DeepSeek / GLM)
        → 消息格式转换 + 工具调用注入
        → 发送 raw text prompt 到后端
        → 流式/非流式接收
        → 工具调用解析校验流水线
        → 格式化为标准 API 响应
    → 响应客户端
```

---

## 快速开始

### 前置条件

- Node.js >= 22
- DeepSeek 账号（用于账号池）或 Token

### 安装

```bash
git clone <your-repo>
cd any2api
npm install
```

### 配置

复制示例配置：

```bash
cp .env.example .env
```

编辑 `.env`，至少配置一种认证方式：

```env
# 方式一：Token（推荐）
DS_TOKEN=your_deepseek_token_here

# 方式二：多个 Token
DS_TOKENS=token1,token2,token3

# 方式三：账号自动登录
DS_ACCOUNTS=email1:password1,email2:password2
```

### 启动

```bash
# 生产
npm start

# 开发（自动重启）
npm run dev
```

启动后输出：

```
DeepSeek 2API running on http://localhost:3000

API Endpoints:
  Health:       GET  /
  OpenAI:       POST /v1/chat/completions
  Claude:       POST /v1/messages
  Models:       GET  /v1/models
  DeepSeek native: POST /api/v0/chat/completion

Admin Panel:    http://localhost:3000/admin
Performance:    http://localhost:3000/performance
```

---

## API 端点

### OpenAI 兼容 — `/v1/chat/completions`

完全兼容 [OpenAI Chat Completions API](https://platform.openai.com/docs/api-reference/chat) 格式。

```bash
curl http://localhost:3000/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "deepseek-v4-flash",
    "messages": [{"role": "user", "content": "Hello!"}],
    "stream": true
  }'
```

**扩展字段**：

| 字段 | 类型 | 默认 | 说明 |
|------|------|------|------|
| `thinking_enabled` | boolean | `true`（无工具时） | 是否启用推理（thinking） |
| `search_enabled` | boolean | `true` | 是否启用联网搜索（仅 Pro） |
| `merge_thinking` | boolean | env.MERGE_THINKING | 将 thinking 合并到 content |

**响应格式**：

```json
{
  "id": "chatcmpl-...",
  "object": "chat.completion",
  "created": 1719200000,
  "model": "deepseek-v4-flash",
  "choices": [{
    "index": 0,
    "message": {
      "role": "assistant",
      "content": "Hello! How can I help?",
      "reasoning_content": "（模型推理过程）"
    },
    "finish_reason": "stop"
  }],
  "usage": { "prompt_tokens": 10, "completion_tokens": 8 }
}
```

### Anthropic 兼容 — `/v1/messages`

兼容 [Anthropic Messages API](https://docs.anthropic.com/en/api/messages) 格式。支持 Claude Code、Anthropic SDK 直接接入。

```bash
curl http://localhost:3000/v1/messages \
  -H "Content-Type: application/json" \
  -H "anthropic-version: 2023-06-01" \
  -d '{
    "model": "deepseek-v4-flash",
    "max_tokens": 1024,
    "messages": [{"role": "user", "content": "Hello!"}]
  }'
```

**响应格式**：

```json
{
  "id": "msg_...",
  "type": "message",
  "role": "assistant",
  "content": [
    { "type": "text", "text": "Hello!" }
  ],
  "model": "deepseek-v4-flash",
  "stop_reason": "end_turn",
  "usage": { "input_tokens": 10, "output_tokens": 8 }
}
```

**工具调用响应**：

```json
{
  "content": [
    { "type": "tool_use", "id": "toolu_...", "name": "get_weather", "input": {"city": "Beijing"} }
  ],
  "stop_reason": "tool_use"
}
```

### 原生 DeepSeek — `/api/v0/chat/completion`

对应 DeepSeek 官方 Web Chat API 格式，`src/channels/deepseek/native.js` 实现。

### 模型列表 — `/v1/models`

```bash
curl http://localhost:3000/v1/models
```

响应列出所有可用的模型 ID：

```json
{
  "object": "list",
  "data": [
    { "id": "deepseek-v4-flash", "object": "model", ... },
    { "id": "deepseek-v4-pro", "object": "model", ... },
    { "id": "deepseek-v4-pro-search", "object": "model", ... },
    { "id": "deepseek-v4-vision", "object": "model", ... }
  ]
}
```

---

## 工具调用（Tool Calling）

Any2API 实现了完整的工具调用兼容层。模型本身不支持原生工具调用，通过 **prompt 注入 + 后处理校验** 实现。

### 工作原理

```
客户端请求 (tools=[...] + tool_choice="auto")
  ↓
buildToolInstructions() 注入工具定义到 prompt
  ↓
模型输出 <tool_calls>[{"name":"func","arguments":{...}}]</tool_calls>
  ↓
parseToolCallsFromText() 解析 XML/JSON
  ↓
validateToolCallsPipeline() 校验流水线：
  1. validateToolChoice()   — tool_choice 硬性约束
  2. validateToolNames()     — 白名单去幻觉
  3. sanitizeToolArguments() — 参数 JSON 消毒
  ↓
格式化为标准 OpenAI tool_calls / Claude tool_use
```

### 支持的 tool_choice

| 值 | 行为 |
|----|------|
| `"auto"` | 模型自行决定是否调用工具 |
| `"required"` | 后处理校验无工具调用时会写 warning（因为无法强制模型重试） |
| `"none"` | 强制丢弃所有工具调用，转为文本 |
| `{"type":"function","function":{"name":"xxx"}}` | 只保留指定工具的调用 |

### 输出格式

**默认 XML 格式**（精确可控，模型遵循度高）：

```
<tool_calls>[{"name":"get_weather","arguments":{"city":"Beijing"}}]</tool_calls>
```

DeepSeek 渠道会统一使用共享工具提示词模板，强调：无工具时只输出纯文本；有工具时输出合法 JSON 数组；禁止 Markdown 代码块、空标签、伪造工具名。服务端还会对解析出的工具调用执行 `tool_choice` 约束、工具名白名单过滤和参数 JSON 消毒，降低弱模型或内置提示词漂移导致的不稳定工具调用。

**备选 JSON 格式**（设置 `TOOL_FORMAT=json`）：

```json
{"assistant_response": null, "tool_calls": [{"name":"get_weather","arguments":{"city":"Beijing"}}]}
```

### 鲁棒解析

解析器逐步降级，覆盖多种模型输出格式：

| 场景 | 解析结果 |
|------|---------|
| `<tool_calls>[{"name":"x","arguments":{}}]</tool_calls>` | ✅ 标准 XML |
| ````xml\n<tool_calls>[...]</tool_calls>\n```` | ✅ 代码块包裹 |
| 文本 + `<tool_calls>` 混合 | ✅ 文本分离为 content |
| `{"tool_calls": [{"name":"x","arguments":{}}]}` | ✅ 备选 JSON |
| 非法 JSON / 空标签 | ✅ 降级为纯文本 + detectFailedToolParse 诊断 |
| 幻觉工具名 | ✅ 白名单过滤 + warning 日志 |

---

## Token 池与负载均衡

多账号自动管理，实现高并发、高可用。

### 架构

```
Token 池 (auth.js)
├─ 账号注册：token / 账号密码 / 混合
├─ 健康检查：定时轮询，剔除死账号
├─ 并发控制：每个 token 最多 MAX_CONCURRENT_PER_TOKEN
├─ 错误追踪：累积 errorCount，达到阈值自动标记 dead
└─ 动态分配：最小活跃请求优先
    ↓
请求队列 (queue.js)
├─ 先入先出
├─ 超时保护（默认 30s）
├─ 最大队列深度（默认 100）
└─ 负载过高时返回 503
    ↓
会话管理 (session.js)
├─ 每个 token 预创建 N 个会话
├─ 会话复用 / 轮换
├─ 会话过期自动清理
└─ Token 失效时批量清理关联会话
```

### 关键配置

| 变量 | 默认 | 说明 |
|------|------|------|
| `MAX_CONCURRENT_PER_TOKEN` | `2` | 每个 token 最大并发请求数 |
| `TOKEN_DEAD_THRESHOLD` | `5` | 连续错误次数，超限标记为 dead |
| `HEALTH_CHECK_INTERVAL` | `600` | 健康检查间隔（秒） |
| `IDLE_THRESHOLD` | `1800` | 仅检查空闲超过此时间的 token（秒） |

### 错误处理机制

```
请求出错
  ↓
auth.js: markTokenError() → errorCount++
  ↓
errorCount >= TOKEN_DEAD_THRESHOLD
  ↓
标记为 dead → 不再分配新请求
  ↓
定期健康检查恢复（刷新 Token 成功时重置 errorCount = 0）
```

---

## 会话亲和（Conversation Affinity）

让多轮对话固定在同一个 DeepSeek 会话中，避免历史消息累积导致的 token 浪费和角色混淆。

### 工作原理

```
无会话亲和（默认）：
  每轮: [User1, Asst1, User2, Asst2, User3] → 拍平成完整文本 → 大 token 消耗

有会话亲和（ENABLE_CONVERSATION_AFFINITY=true）：
  第1轮: [User1] → DeepSeek 会话 A → 记录 parentMessageId
  第2轮: [User2] → 续接会话 A (parentMessageId) → 更新 parentMessageId
  第3轮: [User3] → 续接会话 A (parentMessageId) → ...
```

### 配置

```env
ENABLE_CONVERSATION_AFFINITY=true
CONVERSATION_TTL_MS=1800000        # 30分钟空闲回收
MAX_CONVERSATIONS=500               # 最多同时保留500个对话
MAX_TURNS_PER_SESSION=10            # 每个会话最多10轮后轮换
```

### 对话 ID 来源

1. 客户端设置 `X-Conversation-Id` HTTP 请求头
2. 未设置时按 messages 哈希自动派生（相同消息 → 同一对话）
3. 每轮响应通过 `X-Response-Message-Id` 头返回当前 message ID

---

## 配置参考

### 完整环境变量

| 变量 | 必填 | 默认 | 说明 |
|------|------|------|------|
| **认证** | | | |
| `DS_TOKEN` | 互斥 | - | 单个 DeepSeek Token |
| `DS_TOKENS` | 互斥 | - | 多个 Token（逗号分隔） |
| `DS_ACCOUNTS` | 互斥 | - | 账号邮箱:密码列表 |
| `GLM_REFRESH_TOKEN` | 可选 | - | GLM/智谱清言 refresh token |
| `API_KEY` | 可选 | - | 管理面板 API Key |
| **服务** | | | |
| `PORT` | 可选 | `3000` | HTTP 监听端口 |
| `HTTPS_PROXY` | 可选 | - | HTTPS 出站代理 |
| `HTTP_PROXY` | 可选 | - | HTTP 出站代理 |
| **Token 池** | | | |
| `MAX_CONCURRENT_PER_TOKEN` | 可选 | `2` | 每 Token 并发上限 |
| `TOKEN_DEAD_THRESHOLD` | 可选 | `5` | 错误上限 |
| `HEALTH_CHECK_INTERVAL` | 可选 | `600` | 健康检查间隔（秒） |
| **会话** | | | |
| `SESSION_TTL` | 可选 | `1800` | 会话缓存有效期（秒） |
| `MAX_REQUESTS_PER_SESSION` | 可选 | `8` | 会话最大请求数 |
| **对话续接** | | | |
| `ENABLE_CONVERSATION_AFFINITY` | 可选 | `false` | 启用会话亲和 |
| `CONVERSATION_TTL_MS` | 可选 | `1800000` | 对话空闲回收（ms） |
| `MAX_CONVERSATIONS` | 可选 | `500` | 最大对话数 |
| `MAX_TURNS_PER_SESSION` | 可选 | `10` | 每会话轮数上限 |
| **输出** | | | |
| `MERGE_THINKING` | 可选 | `false` | thinking 合并到 content |
| `TOOL_FORMAT` | 可选 | `xml` | 工具调用格式（xml/json） |
| **日志** | | | |
| `LOG_DIR` | 可选 | `./logs` | 日志目录 |

---

## 管理面板

内置 Web 管理界面，访问 `http://localhost:3000/admin`。

### 功能

- **Token 池监控**：健康状态、并发数、错误计数、可用性
- **会话管理**：活跃会话列表、过期清理
- **实时日志**：请求流水、错误追踪
- **性能仪表盘**：延迟、吞吐、模型统计

### 页面结构

```
/admin
├── dashboard.html       — 概览仪表盘
├── deepseek.html        — DeepSeek Token 管理
├── glm.html             — GLM Token 管理
├── logs.html            — 实时请求日志
├── performance.html     — 性能监控
├── chat.html            — 交互式聊天测试
├── legacy.html          — 旧版管理页面
└── chat-legacy.html     — 旧版聊天页面
```

### 认证

设置 `API_KEY` 后，访问管理 API 需要 `Authorization: Bearer <API_KEY>` 头。

---

## 性能监控

访问 `http://localhost:3000/performance`。

### 指标

| 指标 | 说明 |
|------|------|
| RPM | 每分钟请求数 |
| TTFB P50/P90 | 首字节到达时间（中位数/90分位） |
| Token Speed | 每秒生成 token 数 |
| 错误率 | 4xx/5xx 占比 |
| 模型分布 | 各模型请求量 |

### 数据流转

```
中间件 (middleware/metrics.js)
  ├─ 每个请求记录：延迟、模型、状态码、token 速度
  ├─ 5 分钟滑动窗口聚合
  └─ 按模型分类统计
      ↓
API 端点 /performance/api/stats
  └─ 返回 JSON 指标
      ↓
前端 performance/index.html
  └─ Chart.js 可视化仪表盘
```

---

## 渠道支持

### DeepSeek（主渠道）

| 特性 | 状态 |
|------|------|
| 流式输出 | ✅ 实时 SSE |
| 非流式 | ✅ |
| 工具调用 | ✅ `<tool_calls>` XML 注入 |
| 多模型 | ✅ flash / pro / vision / pro-search |
| 联网搜索 | ✅ |
| 推理（thinking） | ✅ `reasoning_content` 扩展字段 |
| 图片理解 | ✅ vision 模型自动上传 |
| 对话续接 | ✅ 会话亲和 |
| PoW 求解 | ✅ WebAssembly 内置求解 |
| 会话轮换 | ✅ 超过 MAX_REQUESTS_PER_SESSION 自动创建新会话 |

### GLM / 智谱清言（辅助渠道）

| 特性 | 状态 |
|------|------|
| 流式输出 | ✅ SSE |
| 非流式 | ✅ |
| 工具调用 | ✅ 兼容层 |
| 访客模式 | ✅ 自动获取临时 token |
| 长期模式 | ✅ 配置 GLM_REFRESH_TOKEN |
| 图片生成 | ✅ CogView 系列 |

### 模型映射

```javascript
// DeepSeek
'deepseek-v4-flash'      → model_type: 'default'
'deepseek-v4-pro'        → model_type: 'expert'
'deepseek-v4-pro-search' → model_type: 'expert' + search_enabled: true
'deepseek-v4-vision'     → model_type: 'vision'

// GLM 系列
'glm-4'    → 最新 GLM 对话模型
'glm-4v'   → 视觉模型
'cogview'  → 图像生成
```

---

## 高可用设计

### 写入安全

所有 SSE 写入操作自带连接状态检查，写入前确认 `!res.writableEnded && !res.destroyed`，
写入失败时静默返回，不会触发 `ERR_STREAM_WRITE_END`。

### 缓冲上限

`contentBuffer` 上限 256KB，超限后截断保留前 256KB，防止单次大输出 OOM。

### 客户端断开

```javascript
// 统一通过 setupClientDisconnect() 管理
// - 自动监听客户端 close 事件
// - 安全 await streamBody.cancel()（防未处理 rejection）
// - 去重避免重复 cancel
```

### 全局未处理 Rejection

```javascript
// index.js 启动时注册
setupUnhandledRejectionHandler();
// 过滤已知可忽略错误（cancel/abort/pipe）
// 其他未处理 rejection 写日志不崩溃
```

### 工具调用校验流水线

见 [工具调用](#工具调用tool-calling) 章节，3 层校验确保 API 契约合规。

### 会话失效自愈

DeepSeek Web 端可能返回 `DeepSeek error 0: invalid chat session id`，通常表示缓存的 `chat_session_id` 已被上游判定失效。服务会自动清理对应 Token 的会话缓存与会话亲和绑定，并在同一次请求内重新创建会话重试一次，避免连续复用失效会话导致 `/v1/messages` 或 `/v1/chat/completions` 持续 500。

---

## 开发指南

### 项目结构

```
src/
├── adapters/           # 协议转换层
│   └── claude.js       # Claude → OpenAI 请求转换
├── channels/           # 后端渠道
│   ├── deepseek/
│   │   ├── handlers.js # 请求处理（OpenAI + Claude 协议）
│   │   ├── client.js   # DeepSeek Web API 客户端
│   │   ├── models.js   # 模型映射
│   │   ├── native.js   # 原生 DeepSeek 协议端点
│   │   └── index.js    # 渠道路由
│   └── glm/
│       ├── handlers.js
│       ├── client.js
│       ├── models.js
│       ├── stream-parser.js
│       ├── token-manager.js
│       ├── utils.js
│       └── index.js
├── middleware/         # Express 中间件
│   ├── auth.js
│   ├── error-handler.js
│   ├── logger.js
│   └── metrics.js
├── routes/            # HTTP 路由
│   ├── api.js         # 主 API 端点
│   ├── admin.js       # 管理 API
│   ├── index.js       # 路由聚合
│   ├── legacy.js      # 旧版兼容
│   └── performance.js # 性能 API
├── services/          # 核心服务
│   ├── auth.js        # Token 池管理
│   ├── conversation.js# 对话续接
│   ├── queue.js       # 请求队列
│   ├── session.js     # 会话管理
│   └── upload.js      # 图片上传
├── utils/             # 工具函数
│   ├── response-utils.js  # 响应工具 + 工具调用解析
│   ├── claude-response.js # Claude 格式构建
│   ├── openai-response.js # OpenAI 格式构建
│   ├── sse.js         # SSE 流解析
│   ├── model-router.js# 模型路由
│   ├── headers.js     # 代理/请求头
│   └── pow.js         # PoW 求解
├── admin/             # 管理面板前端
├── performance/       # 性能监控前端
└── index.js           # 入口
```

### 添加新渠道

1. 在 `channels/` 下创建新目录
2. 实现 `handlers.js`（请求处理）
3. 实现 `client.js`（后端通信）
4. 在 `src/utils/model-router.js` 注册模型前缀
5. 在 `src/routes/api.js` 注册路由

### 代码风格

- ES Module（`type: "module"`）
- JSDoc 注释所有导出函数
- 中/英文双语代码注释
- 高可用：安全写入、缓冲上限、catch 覆盖所有异步路径

---

## 常见问题

### Q: Token 被 Ban 了怎么办？

自动处理：连续错误超过 `TOKEN_DEAD_THRESHOLD`（默认5次）后标记为 dead。
如果是账号模式，下次健康检查会尝试重新登录刷新。

手动操作：在管理面板中将 Token 标记为 alive，或重启服务。

### Q: 工具调用失败了？

1. 检查模型是否支持复杂的指令遵循（flash 较好，某些弱模型可能不遵循 JSON/XML 格式）
2. 观察日志中是否有 `[Tool validation]` / `[Tool pipeline]` warning
3. 设置 `TOOL_FORMAT=json` 尝试不同格式
4. 日志中 `[Tool args]` 提示参数格式问题

### Q: 流式响应卡住？

- 检查 `TCP_NODELAY` 是否启用（默认启用）
- 检查代理（nginx/cloudflare）是否缓冲了 SSE
- 检查客户端是否断开了连接（日志 `[HA]` 标记）

### Q: 如何调试？

```bash
# 查看完整日志
tail -f logs/deepseek-2api/*.log

# 检查 Token 池状态
curl http://localhost:3000/admin/api/pool -H "Authorization: Bearer $API_KEY"

# 检查性能指标
curl http://localhost:3000/performance/api/stats
```

---

## 许可证

MIT License

---

*Any2API — 让每个模型都拥有一致的 API 接口。*
