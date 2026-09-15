# OmniAPI

> Web-to-API 代理 · 将 DeepSeek Web 端统一转换为 OpenAI / Claude 兼容 API


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

**OmniAPI** 是一个 Web-to-API 代理服务，将 DeepSeek 上游 Web 端的对话能力，统一转换为标准的 **OpenAI Chat Completions** 和 **Claude Messages** API 格式。

你可以使用任意 OpenAI/Claude SDK 调用这些模型，无需适配各平台的原生 API。

## 核心特性

| 特性 | 说明 |
|------|------|
| 🔌 **多协议支持** | OpenAI `chat/completions`、Claude `messages`、原生 `responses` |
| 🚀 **全流式响应** | 所有端点仅支持 SSE 流式输出，实时获取生成内容 |
| 🧩 **上游渠道** | DeepSeek Web 端，统一抽象层 |
| 🖼️ **多模态输入** | 图片 / 文档 / 音视频随消息上送，自动转交上游 |
| 🧠 **思考内容分离** | 思考（reasoning）与正文分通道流式输出，客户端可分别展示 |
| 📊 **标准 usage 上报** | 各协议均返回 token 用量、缓存命中与思考 token 拆分 |
| 🔄 **Token 池管理** | 多账号轮转、自动刷新、并发控制、健康检查 |
| 🛡️ **限流自愈** | 凭据限流自动切换冷却，IP 级限流快速失败并明确报错 |
| 🛠️ **工具调用** | 支持 Function Calling，自动注入 XML 格式指令 |
| ⚙️ **Prompt 注入** | 可开关的兼容性注入，适配不同上游格式 |
| 🐳 **Docker 就绪** | 一键部署，支持 Docker Compose |

## 快速开始

### 本地运行

```bash
# 安装依赖
npm install

# 构建管理后台前端（首次或前端有改动时）
npm run build

# 启动服务（默认端口 3000）
npm start
```

### Docker 部署（推荐）

无需克隆源码，可直接使用预构建镜像：

```bash
docker run -d \
  --name omni \
  -p 3000:3000 \
  -e DS_ACCOUNTS=
  -e API_KEY="sk-zhi" \
  -v omni-data:/data \
  -v "$(pwd)/logs:/app/logs" \
  ghcr.io/zhi-java/any2api:latest
```

镜像支持 `linux/amd64` 与 `linux/arm64`，Docker 会自动选择对应架构。
`/data` 卷用于持久化配置，不挂载则容器重建后后台配置会丢失。

#### 使用 Docker Compose

```bash
# 1. 复制环境配置
cp .env.docker .env

# 2. 编辑 .env，配置 DeepSeek 认证信息
#    例如 DeepSeek: DS_ACCOUNTS=
#    或 DS_TOKENS=

# 3. 启动服务（默认拉取上面的发布镜像）
docker compose up -d

# 如需从本地源码构建（例如改了代码）
docker compose up -d --build

# 4. 查看日志
docker compose logs -f

# 5. 停止服务
docker compose down
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

| 渠道 | 认证方式 | 模型 |
|------|---------|------|
| **DeepSeek** | 账号密码 / Token 池 | `deepseek-flash` |

> DeepSeek 上游已合并模型能力，不再区分 flash/pro 两档，对外只暴露 `deepseek-flash`。
> 客户端附加后缀（如 `[1m]`）会被自动剥离。

`/v1/models` 会返回完整的模型元数据（上下文长度、输出上限、能力声明），
供客户端自动识别。各字段含义与可配置项见 [配置说明](#配置说明)。

### 多模态输入

图片、文档、音视频可直接随消息上送，服务端会转交上游处理：

```jsonc
{
  "model": "deepseek-flash",
  "messages": [{
    "role": "user",
    "content": [
      { "type": "text", "text": "这张图里有什么？" },
      { "type": "image_url", "image_url": { "url": "data:image/png;base64,..." } }
    ]
  }]
}
```

三种协议的输入格式都已适配：
OpenAI 的 `image_url`、Claude 的 `image_source`、Responses 的 `input_image`。

## 配置说明

只需三项，其余参数均有内置默认值。

```bash
# 上游认证（二选一）
# 方式一：账号密码，逗号分隔（推荐，token 失效时自动重新登录）
DS_ACCOUNTS=
# 方式二：直接给 token，逗号分隔
DS_TOKENS=

# 服务端口（宿主机侧；Docker 部署时映射到此端口）
PORT=3000

# 管理后台 Key，同时用作 API 请求 Key
API_KEY=sk-zhi
```

> 其余参数（并发、超时、日志、上下文长度、缓存命中率展示值等）
> 均可在管理后台「设置」页面调整，改动会持久化到数据目录，
> **无需修改配置文件、也无需重启**。

### 关于内置 Key

`sk-zhi` 是内置放行 Key：无论后台如何轮换主 Key 或增删外部 API Key，
它始终可用，便于固定客户端配置。仅建议在本地/内网使用；对外提供服务时
请在后台另行创建强 Key。

## 高级功能

### Prompt 注入控制

在管理后台「设置 → 服务」中开关「启用工具提示词注入」，控制是否向上游
Web 端注入兼容性指令：

| 模式 | 行为 |
|------|------|
| **启用**（默认） | 注入 `<function_calls>` XML 模板、角色标签，将工具调用转换为上游特定格式 |
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
- **Internal Events 层**：渠道输出统一事件序列，由渲染器转换为不同协议格式
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

npm run build      # 构建管理后台前端（Vite + React → src/admin/dist）
npm run web:dev    # 前端热更新开发（需另开服务端，默认代理到 3000）
```

> 管理后台前端位于 `web/`（Vite + React + TypeScript + Tailwind）。
> `src/admin/dist/` 为构建产物，不入库；本地运行前需先执行一次 `npm run build`，
> Docker 部署则由 Dockerfile 多阶段构建自动完成。

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
├── channels/        # 上游渠道实现（deepseek）
├── core/            # 核心逻辑（生成编排、模型解析、Prompt 策略）
├── protocols/       # 协议适配器与渲染器
├── routes/          # API 路由
├── middleware/      # 认证、日志、错误处理
├── services/        # Token 池、配置持久化、会话管理
├── utils/           # 工具函数
└── index.js         # 入口

web/                 # 管理后台前端（Vite + React + TS + Tailwind）
├── src/
│   ├── pages/       # 首页 / 渠道 / 凭据 / API Keys / 设置 / 日志 / 监控
│   ├── components/  # 设计系统组件与外壳
│   ├── lib/         # API 客户端、轮询 hooks、格式化
│   └── index.css    # S4 Soft Product 设计 token
└── vite.config.ts   # 产物输出到 src/admin/dist
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
- [Docker 快速参考](docs/Docker快速参考.md) — 常用命令速查
- [设计系统](docs/design-system-s4-soft-product.md) — 管理后台的视觉与交互规范

## 许可证

[MIT](LICENSE)
