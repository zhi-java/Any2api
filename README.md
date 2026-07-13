# OmniAPI

> 多通道 Web-to-API 代理 · 将 DeepSeek、GLM、Qwen、Kimi 等 Web 端统一转换为 OpenAI / Claude 兼容 API


---

## 📖 目录

- [项目简介](#项目简介)
- [核心特性](#核心特性)
- [快速开始](#快速开始)
- [API 端点](#api-端点)
- [渠道与模型支持](#渠道与模型支持)
- [配置说明](#配置说明)
- [高级功能](#高级功能)
- [开发指南](#开发指南)
- [更多文档](#更多文档)

---

## 项目简介

**OmniAPI** 是一个多通道 Web-to-API 代理服务，将 DeepSeek、GLM、Qwen、Kimi 等上游 Web 端的对话能力，统一转换为标准的 **OpenAI Chat Completions** 和 **Claude Messages** API 格式。

你可以使用任意 OpenAI/Claude SDK 调用这些模型，无需适配各平台的原生 API。

## 核心特性

| 特性 | 说明 |
|------|------|
| 🔌 **多协议支持** | OpenAI `chat/completions`、Claude `messages`、原生 `responses` |
| 🚀 **全流式响应** | 所有端点仅支持 SSE 流式输出，实时获取生成内容 |
| 🧩 **多上游渠道** | DeepSeek、GLM、Qwen、Kimi，统一抽象层 |
| 🔄 **Token 池管理** | 多账号轮转、自动刷新、并发控制、健康检查 |
| 🛠️ **工具调用** | 支持 Function Calling，自动注入 XML 格式指令 |
| ⚙️ **Prompt 注入** | 可开关的兼容性注入，适配不同上游格式 |
| 🐳 **Docker 就绪** | 一键部署，支持 Docker Compose |

## 快速开始

### 本地运行

```bash
# 安装依赖
npm install

# 启动服务（默认端口 3000）
npm start
```

### Docker 部署（推荐）

```bash
# 1. 复制环境配置
cp .env.docker .env

# 2. 编辑 .env，配置认证信息（至少配置一个渠道）
#    例如 DeepSeek: DS_ACCOUNTS="手机号:密码,手机号:密码"
#    或 DS_TOKENS="token1,token2"

# 3. 启动服务
docker-compose up -d

# 4. 查看日志
docker-compose logs -f

# 5. 停止服务
docker-compose down
```

### 验证服务

```bash
curl http://localhost:3000/v1/models
```

详细部署说明请参考 [Docker 部署指南](docs/Docker部署指南.md)。

## API 端点

| 方法 | 端点 | 协议 | 说明 |
|------|------|------|------|
| `POST` | `/v1/chat/completions` | OpenAI | 标准 OpenAI 格式（推荐） |
| `POST` | `/v1/messages` | Claude | Claude Messages 格式 |
| `POST` | `/v1/responses` | 原生 | Internal Events 原生端点 |
| `GET` | `/v1/models` | — | 获取可用模型列表 |

> **注意**：所有端点**仅支持流式响应**（`stream: true`），`stream: false` 会返回 400 错误。

## 渠道与模型支持

| 渠道 | 认证方式 | 模型示例 |
|------|---------|---------|
| **DeepSeek** | 账号密码 / Token 池 | `deepseek-v4-pro`、`deepseek-v4-flash` |
| **GLM** | Refresh Token / 访客模式 | `glm-5.2` |
| **Qwen** | Token 池 / 账号密码 | `qwen3.7-plus`、`qwen3.7-max`、`qwen3.6-plus` |
| **Kimi** | Token 池 | `kimi-k2.6`、`kimi-k2.6-thinking` |

**模型路由优先级**：DeepSeek → GLM → Qwen → Kimi。客户端附加后缀（如 `[1m]`）会被自动剥离。

### 模型名称后缀

各渠道支持的功能后缀：

| 渠道 | 后缀 | 功能 |
|------|------|------|
| Qwen | `-thinking` | 思考模式 |
| Qwen | `-search` | 联网搜索 |
| Qwen | `-deep-research` | 深度研究 |
| Qwen | `-image` | 图像生成 |
| Qwen | `-video` | 视频生成 |
| Kimi | `-thinking` | 思考模式 |

## 配置说明

### 通用配置

```bash
# 服务端口
PORT=3000

# API 密钥（客户端调用需携带）
API_KEY=sk-your-secret-key

# 日志目录
LOG_DIR=./logs

# 调试模式
CLIENT_DEBUG_LOG=true
```

### DeepSeek 配置

```bash
# 账号密码方式（推荐）
DS_ACCOUNTS="手机号:密码,手机号:密码"

# Token 方式
DS_TOKENS="token1,token2"

# 并发控制
DS_MAX_CONCURRENT_PER_TOKEN=5
DS_MAX_QUEUE_SIZE=100

# 上下文超限时自动回退到 Flash 模型
DEEPSEEK_CONTEXT_FALLBACK=true
```

### Qwen 配置

```bash
# Token 方式
QWEN_TOKENS="token1,token2"

# 账号密码方式（自动登录刷新）
QWEN_ACCOUNTS="email:password,email:password"

# 并发与限流（覆盖通用默认值）
QWEN_MAX_CONCURRENT_PER_TOKEN=5
QWEN_MAX_QUEUE_SIZE=100
QWEN_QUEUE_TIMEOUT_MS=30000
QWEN_ACCOUNT_MIN_INTERVAL_MS=1000
QWEN_RATE_LIMIT_BASE_COOLDOWN_MS=5000
QWEN_RATE_LIMIT_MAX_COOLDOWN_MS=60000
QWEN_MAX_TOKEN_ERRORS=5
```

> 若同时配置 `QWEN_TOKENS` 和 `QWEN_ACCOUNTS`，两者会合并到同一凭证池。

### Kimi 配置

```bash
# 单个 Token
KIMI_AUTH_TOKEN="your-token"

# Token 池（优先于单 Token）
KIMI_AUTH_TOKENS="token1,token2"

# 长文本附件阈值（字节）
KIMI_TEXT_ATTACHMENT_THRESHOLD_BYTES=450000
```

> 若未配置任何 Kimi 凭证，Kimi 请求会返回上游不可用错误。

### GLM 配置

```bash
# Refresh Token（推荐）
GLM_REFRESH_TOKEN="your-refresh-token"

# 或访客模式
GLM_GUEST_MODE=true

# Cookie（可选）
GLM_COOKIE="..."
```

## 高级功能

### Prompt 注入控制

`ENABLE_PROMPT_INJECTION` 控制是否向上游 Web 端注入兼容性指令：

```bash
# 启用（默认）：自动注入角色标签、工具调用 XML 格式
ENABLE_PROMPT_INJECTION=true

# 禁用：直接透传客户端请求原文，不做任何改写
ENABLE_PROMPT_INJECTION=false
```

| 模式 | 行为 |
|------|------|
| **启用** | 注入 `<function_calls>` XML 模板、角色标签，将工具调用转换为上游特定格式 |
| **禁用** | 不添加任何内容，完整保留客户端 JSON 请求体，工具调用需由客户端自行处理 |

> 禁用时，多轮对话历史不会被自动压缩为单条消息，请确保客户端请求已包含完整上下文。

### Responses API

`POST /v1/responses` 是基于 Internal Events 层实现的原生端点，**不经过** `/v1/chat/completions` 桥接。

支持的输入格式：
- `input: "text"` — 纯文本字符串
- `input: [{ "role": "user", "content": "text" }]` — 标准消息数组
- `input_text` 类型的消息项

同时支持流式（`stream: true`）和非流式（`stream: false`）响应。

### 架构概览

```
客户端请求
  ↓
Express 路由 (src/routes/)
  ↓
协议适配器 (src/protocols/*/request-adapter.js)
  ↓
标准化 Internal Request (src/core/internal-request.js)
  ↓
模型路由解析 (src/utils/model-router.js)
  ↓
渠道分发 (src/core/generation.js → src/channels/*/runner.js)
  ↓
Internal Event 流 (src/core/internal-events.js)
  ↓
协议渲染器 (src/protocols/*/renderer.js)
  ↓
SSE 响应流
```

核心设计理念：
- **Internal Events 层**：所有渠道输出统一事件序列，由渲染器转换为不同协议格式
- **Token 池管理**：多账号轮转、自动刷新、并发控制、健康检查、死亡标记
- **三层配置**：默认值 → 环境变量 → 磁盘配置（管理后台可修改）

## 开发指南

### 环境要求
- Node.js 20+
- npm 或 yarn
- （可选）Docker & Docker Compose

### 常用命令

```bash
npm start          # 启动服务
npm run dev        # 开发模式（文件变更自动重启）
npm test           # 运行所有测试
```

### 运行测试

```bash
# 运行全部测试
npm test

# 运行单个测试文件
node --test test/core/generation.test.js

# 运行特定渠道测试
node --test test/channels/deepseek/
```

### 项目结构

```
src/
├── channels/        # 上游渠道实现（deepseek、glm、qwen、kimi）
├── core/            # 核心逻辑（生成编排、模型解析、Prompt 策略）
├── protocols/       # 协议适配器与渲染器
├── routes/          # API 路由
├── middleware/      # 认证、日志、错误处理
├── services/        # Token 池、配置持久化、会话管理
├── utils/           # 工具函数
├── admin/           # 管理面板前端
└── index.js         # 入口
```

### 添加新渠道

1. 在 `src/channels/<name>/` 创建目录
2. 实现 `runner.js`、`models.js`、`stream-parser.js`、`auth.js`
3. 在 `src/utils/model-router.js` 添加路由规则
4. 在 `src/core/generation.js` 的 `RUNNERS` 注册
5. 在 `/v1/models` 端点添加模型列表
6. 编写测试

### 添加新模型

在对应渠道的 `models.js` 中添加模型映射即可。

## 更多文档

- [Docker 部署指南](docs/Docker部署指南.md) — 详细的容器化部署说明
- [管理面板使用](docs/管理面板.md) — 后台配置与监控
- [API 参考](docs/API.md) — 各端点的请求/响应格式

## 许可证

[MIT](LICENSE)

---

> 🤖 本项目使用 [Trellis](.trellis/) 进行任务管理，采用三阶段开发流程（规划 → 实现 → 检查）。