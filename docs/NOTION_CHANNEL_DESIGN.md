# Notion AI 渠道接入设计文档

> 在 Any2API 中集成 Notion AI 作为第三个后端渠道（继 DeepSeek、GLM 之后）。
> 基于 [NOTION_NODEJS_REVERSE_PROXY.md](./NOTION_NODEJS_REVERSE_PROXY.md) 逆向分析。

- 设计日期：2026-06-25
- 状态：待实现
- 标签：notion, channel, reverse-proxy, header-forgery

---

## 目录

- [1. 设计目标与范围](#1-设计目标与范围)
- [2. 架构总览](#2-架构总览)
- [3. 文件变更清单](#3-文件变更清单)
- [4. Channel 模块设计](#4-channel-模块设计)
  - [4.1 models.js — 模型定义](#41-modeljs--模型定义)
  - [4.2 session.js — 会话管理](#42-sessionjs--会话管理)
  - [4.3 client.js — HTTP 请求伪造客户端](#43-clientjs--http-请求伪造客户端)
  - [4.4 stream-parser.js — NDJSON 流解析](#44-stream-parserjs--ndjson-流解析)
  - [4.5 handlers.js — 协议处理](#45-handlersjs--协议处理)
  - [4.6 index.js — 渠道入口](#46-indexjs--渠道入口)
- [5. 路由层修改](#5-路由层修改)
  - [5.1 model-router.js](#51-model-routerjs)
  - [5.2 routes/api.js](#52-routesapijs)
  - [5.3 index.js 启动流程](#53-indexjs-启动流程)
- [6. 数据流详解](#6-数据流详解)
- [7. 错误处理](#7-错误处理)
- [8. 首次实现范围（MVP）](#8-首次实现范围mvp)
- [9. 后续扩展（非首次范围）](#9-后续扩展非首次范围)
- [10. 配置参考](#10-配置参考)

---

## 1. 设计目标与范围

### 目标

在 Any2API 中新增 **Notion AI** 渠道，将 Notion AI 的 Web 接口封装为标准 OpenAI / Anthropic API，扩展渠道多样性。

### MVP 范围

- 支持核心 AI 推理流（`POST /api/v3/runInferenceTranscript`）
- 流式（SSE）和非流式响应
- Probe JSON 文件认证
- OpenAI 和 Anthropic 双协议兼容
- 精确模型名匹配，不带 `notion-` 前缀

### 非首次范围

- 会话自动刷新（浏览器自动化）
- 对话续接（thread persistence）
- 多账号支持
- Web 搜索
- 文件上传
- 浏览器回退（trust-rule-denied 防护绕过）

---

## 2. 架构总览

### 渠道结构

```
src/channels/notion/
├── index.js          # 渠道入口
├── handlers.js       # OpenAI/Claude 协议处理
├── client.js         # HTTP 请求伪造客户端
├── models.js         # 模型映射定义
├── session.js        # Probe JSON 会话管理
└── stream-parser.js  # NDJSON → 统一事件流
```

### 数据流

```
Client:
  POST /v1/chat/completions { model: "claude-sonnet-4-6", messages: [...] }
     │
     ▼
routeModel("claude-sonnet-4-6")
  ├─ deepseek-*?  → no
  ├─ glm-*/cogview-*? → no
  └─ NOTION_MODELS.includes()? → { channel: 'notion', model: 'claude-sonnet-4-6' }
     │
     ▼
notion.handleOpenAI(req, res)
  │
  ├─ 1. session.getSessionInfo() → cookies, user_id, space_id, client_version
  ├─ 2. handlers.buildTranscriptPayload(messages, model, spaceId)
  ├─ 3. client.runInferenceTranscript(payload, session)
  │      └─ POST https://www.notion.so/api/v3/runInferenceTranscript
  │         Headers: cookie, x-notion-active-user-header, x-notion-space-id,
  │                  notion-client-version, sec-ch-ua, referer, ...
  │         Accept: application/x-ndjson
  ├─ 4. stream-parser.parseNotionNDJSON(body) → [{ type, content }, ...]
  └─ 5. handlers → OpenAI SSE / Claude SSE
     │
     ▼
Client 收到标准协议响应
```

---

## 3. 文件变更清单

### 新增文件

| 文件 | 行数预估 | 职责 |
|------|---------|------|
| `src/channels/notion/models.js` | ~15 | 模型列表定义 |
| `src/channels/notion/session.js` | ~80 | Probe JSON 加载与缓存 |
| `src/channels/notion/client.js` | ~150 | Notion HTTP 客户端（头伪造 + API 调用） |
| `src/channels/notion/stream-parser.js` | ~60 | NDJSON → 统一事件 |
| `src/channels/notion/handlers.js` | ~280 | 协议转换（OpenAI + Claude） |
| `src/channels/notion/index.js` | ~30 | 渠道统一入口 |

### 修改文件

| 文件 | 修改内容 |
|------|---------|
| `src/utils/model-router.js` | + `NOTION_MODELS.includes()` 判断 |
| `src/routes/api.js` | + import notion, 路由分发, /v1/models 合并 |
| `src/index.js` | + 启动时检测 `NOTION_PROBE_PATH` 加载 session |
| `.env.example` | + `NOTION_PROBE_PATH` 配置注释 |

---

## 4. Channel 模块设计

### 4.1 models.js — 模型定义

```javascript
/**
 * Notion AI 支持的模型列表
 *
 * 这些是 Notion AI 内部实际可用的模型名称，
 * 客户端请求时直接使用这些名称，不带 notion- 前缀。
 */
export const NOTION_MODELS = [
  'claude-sonnet-4-6',
  'claude-opus-4-8',
  'claude-haiku-4-5-20251001',
];

/**
 * 判断模型名是否属于 Notion 渠道
 */
export function isNotionModel(model) {
  return NOTION_MODELS.includes(model);
}
```

### 4.2 session.js — 会话管理

#### Probe Payload 结构

```typescript
interface ProbePayload {
  email: string;           // 必需
  user_id: string;         // 必需
  user_name?: string;      // 可选，自动补齐
  space_id: string;        // 必需
  space_view_id?: string;  // 可选，自动补齐
  space_name?: string;     // 可选，自动补齐
  client_version: string;  // 必需
  cookies: { name: string; value: string }[];  // 必需，至少含 token_v2
}
```

#### 接口设计

| 函数 | 说明 |
|------|------|
| `loadSession(probePath)` | 加载 Probe JSON，校验必需字段，返回 SessionInfo |
| `getSessionInfo()` | 获取当前会话信息（已加载则返回缓存） |
| `ensureMetadata(session)` | 调用 `loadUserContent` 自动发现补齐可选字段 |
| `getCookieHeader(session)` | 将 cookies 数组拼成 `"token_v2=xxx"` 格式 |

#### SessionInfo 结构（内部）

```typescript
interface SessionInfo {
  probePath: string;
  email: string;
  userId: string;
  userName: string;
  spaceId: string;
  spaceViewId: string;
  spaceName: string;
  clientVersion: string;
  cookies: { name: string; value: string }[];
}
```

#### 补齐逻辑

```javascript
// 当 probe.json 中 user_name/space_name/space_view_id 缺失时
const localPart = payload.email.split('@')[0];
const resolvedUserName = payload.user_name || localPart;
const resolvedSpaceName = payload.space_name || `${resolvedUserName}'s Space`;
```

### 4.3 client.js — HTTP 请求伪造客户端

#### Notion 上游配置

```javascript
const NOTION_UPSTREAM = {
  baseURL: 'https://www.notion.so',
  originURL: 'https://www.notion.so',
  homeURL: 'https://www.notion.so',
  aiURL: 'https://www.notion.so/ai',
};
```

#### 请求头构建

每个请求必须模拟 Chrome 浏览器完整签名：

| Header | 值 | 说明 |
|--------|-----|------|
| `cookie` | `token_v2=xxx` | 来自 session.cookies |
| `x-notion-active-user-header` | `uuid` | 用户 UUID |
| `x-notion-space-id` | `32-hex` | 工作空间 ID |
| `notion-client-version` | `25.3.56.8` | 从 Probe JSON 获取 |
| `notion-audit-log-platform` | `web` | 固定值 |
| `accept-language` | `en-US,en;q=0.9` | 默认 |
| `origin` | `https://www.notion.so` | 固定 |
| `user-agent` | `Mozilla/5.0 (Windows NT 10.0; Win64; x64) ...` | Chrome 145 |
| `sec-ch-ua` | `"Google Chrome";v="145", ...` | 固定 |
| `sec-ch-ua-platform` | `"Windows"` | 固定 |

#### Content-Type 与 Accept 联动

- 普通 API：`Content-Type: application/json` + `Accept: application/json`
- 推理请求：`Content-Type: application/json` + `Accept: application/x-ndjson`

#### Referer 策略

Referer 按端点动态选择，错误时 Notion 可能返回 403：

```javascript
function resolveReferer(endpoint, payload) {
  switch (endpoint) {
    case 'runInferenceTranscript':
      return payload.createThread
        ? 'https://www.notion.so/ai'
        : `https://www.notion.so/chat?t=${cleanThreadId}&wfv=chat`;
    case 'loadUserContent':
    case 'getSpacesInitial':
      return 'https://www.notion.so';
    default:
      return 'https://www.notion.so/ai';
  }
}
```

#### 对外接口

| 方法 | 说明 |
|------|------|
| `runInferenceTranscript(payload, session)` | AI 推理核心，返回 NDJSON ReadableStream |
| `loadUserContent(session)` | 加载用户信息，用于元数据补齐 |

### 4.4 stream-parser.js — NDJSON 流解析

Notion 的 `runInferenceTranscript` 返回 `application/x-ndjson` 流，每行一个 JSON 对象。

#### 输入 → 输出

```
NDJSON 输入                                  统一事件输出
─────────────────                           ─────────────
{"type":"delta","delta":{"content":"你好"}}  → { type: 'content', content: '你好' }
{"type":"delta","delta":{"content":"世界"}}  → { type: 'content', content: '世界' }
{"type":"status","stage":"inference",       → { type: 'done' }
           "status":"done"}
{"type":"error","message":"..."}             → { type: 'error', message: '...' }
```

#### 解析器接口

```javascript
export async function* parseNotionNDJSON(body: ReadableStream): AsyncGenerator<StreamEvent>
```

### 4.5 handlers.js — 协议处理

#### 导出的入口函数

```javascript
export async function handleOpenAICompletion(req, res, session);
export async function handleClaudeMessages(req, res, session);
```

#### OpenAI 处理流程

```
1. 校验 model / messages
2. messages → prompt 文本（复用 textFromContent 逻辑）
3. 构建 runInferenceTranscript payload
4. 调用 client.runInferenceTranscript(payload, session)

[stream=true]:
  - writeHead(200, SSE headers)
  - 遍历 parseNotionNDJSON 实时转 SSE
    - content → data: {"choices":[{"delta":{"content":"..."}}]}
    - done    → data: [DONE]
  - res.end()

[stream=false]:
  - 遍历 NDJSON 收集完整内容
  - 组装 OpenAI JSON 响应
  - res.json(response)
```

#### Claude 处理流程

与现有 `handleDeepSeekClaude` 一致：
1. `convertClaudeRequest(claudeReq)` → OpenAI 格式
2. 走 OpenAI 处理流程
3. 返回结果转换为 Claude SSE/JSON

#### 模型名透传

请求中的 `model` 原样透传到响应中，不做映射：

```javascript
const response = {
  model: req.body.model,  // 原样返回 "claude-sonnet-4-6"
  // ...
};
```

### 4.6 index.js — 渠道入口

```javascript
import { handleOpenAICompletion, handleClaudeMessages } from './handlers.js';
import { NOTION_MODELS } from './models.js';

export default {
  handleOpenAI: handleOpenAICompletion,
  handleClaude: handleClaudeMessages,
  models: NOTION_MODELS,
};
```

---

## 5. 路由层修改

### 5.1 model-router.js

```javascript
import { NOTION_MODELS } from '../channels/notion/models.js';

export function routeModel(modelName) {
  const normalized = normalizeRequestedModelName(modelName);
  if (!normalized) throw new Error('模型名称是必需的');

  if (normalized.startsWith('deepseek-'))
    return { channel: 'deepseek', model: normalized };
  if (normalized.startsWith('glm-') || normalized.startsWith('cogview-'))
    return { channel: 'glm', model: normalized };
  if (NOTION_MODELS.includes(normalized))
    return { channel: 'notion', model: normalized };

  throw new Error(`未知模型: ${normalized}。支持的模型: deepseek-*, glm-*, cogview-*, ${NOTION_MODELS.join(', ')}`);
}
```

### 5.2 routes/api.js

```javascript
import notion from '../channels/notion/index.js';

// /v1/chat/completions
if (channel === 'notion') {
  return await notion.handleOpenAI(req, res);
}

// /v1/messages
if (channel === 'notion') {
  return await notion.handleClaude(req, res);
}

// /v1/models — 在已有 deepseek + glm 模型基础上追加
const notionModels = notion.models.map(id => ({
  id, object: 'model', created: 1718000000, owned_by: 'notion',
}));
```

### 5.3 index.js 启动流程

```javascript
// 在 initTokenPool 之后
let notionSession = null;
const notionProbePath = process.env.NOTION_PROBE_PATH;
if (notionProbePath) {
  const { loadSession } = await import('./channels/notion/session.js');
  notionSession = loadSession(notionProbePath);
  console.log(`Notion channel ready: ${notionSession.email}`);
}
```

---

## 6. 数据流详解

### 完整请求链路示例

```json
// 客户端请求
POST /v1/chat/completions
{
  "model": "claude-sonnet-4-6",
  "messages": [{"role": "user", "content": "Hello!"}],
  "stream": true
}
```

经过 handlers 转换后发往 Notion 的请求体：

```json
// POST https://www.notion.so/api/v3/runInferenceTranscript
// Headers: Accept: application/x-ndjson, Cookie: token_v2=..., ...
{
  "id": "thread-uuid",
  "spaceId": "32-hex-space-id",
  "threadId": "thread-uuid",
  "transactions": [{
    "id": "tx-uuid",
    "shardId": 1234,
    "spaceId": "32-hex-space-id",
    "transactions": [{
      "type": "update",
      "operations": [
        { "pointer": { "table": "thread", "id": "thread-uuid", "spaceId": "..." },
          "path": [], "command": "set",
          "args": { "type": "workflow", "lastEditedTime": 1712345678000 } },
        { "pointer": { "table": "step", "id": "step-uuid-1", "spaceId": "..." },
          "path": [], "command": "set",
          "args": {
            "type": "user",
            "value": [{"type":"text","text":"[User]: Hello!"}],
            "attachments": [],
            "id": "step-uuid-1",
            "parent_id": "thread-uuid",
            "parent_table": "thread",
            "created_time": 1712345678000,
            "last_edited_time": 1712345678000
          } },
        { "pointer": { "table": "step", "id": "step-uuid-2", "spaceId": "..." },
          "path": [], "command": "set",
          "args": {
            "type": "config",
            "value": {
              "type": "workflow",
              "model": "claude-sonnet-4-6",
              "enableAgentAutomations": true,
              "enableAgentIntegrations": true,
              "enableCustomAgents": true,
              "enableScriptAgent": true,
              "enableCreateAndRunThread": true,
              "useWebSearch": false,
              "searchScopes": []
            },
            "id": "step-uuid-2",
            "parent_id": "thread-uuid",
            "parent_table": "thread",
            "created_time": 1712345678001,
            "last_edited_time": 1712345678001
          } }
      ]
    }]
  }],
  "createThread": true,
  "model": "claude-sonnet-4-6",
  "type": "workflow"
}
```

---

## 7. 错误处理

### 认证错误

| 场景 | 处理方式 |
|------|---------|
| 未配置 `NOTION_PROBE_PATH` | 请求 Notion 模型时返回 `503 channel unavailable` |
| Probe JSON 缺失字段 | 启动时报错，渠道不可用 |
| Notion 返回 401/403 | 返回 `502 upstream error` |
| Notion 返回 trust-rule-denied | 返回 `502`（浏览器回退为未来扩展） |

### HTTP 错误

```javascript
class NotionClientError extends Error {
  constructor(message, { status, code }) {
    super(message);
    this.name = 'NotionClientError';
    this.status = status;
    this.code = code;
  }
}
```

### Handlers 错误转换

```javascript
try {
  // 调用 client
} catch (err) {
  if (err instanceof NotionClientError) {
    // → OpenAI 错误格式: { error: { message, type, code } }
    // → Claude 错误格式: { type: 'error', error: { type, message } }
  }
}
```

---

## 8. 首次实现范围（MVP）

| 特性 | 状态 |
|------|------|
| Probe JSON 会话加载 | ✅ |
| HTTP 请求头伪造 | ✅ |
| runInferenceTranscript 流式推理 | ✅ |
| NDJSON 流解析 | ✅ |
| OpenAI SSE 协议转换 | ✅ |
| Claude /messages 协议转换 | ✅ |
| 非流式响应 | ✅ |
| 模型列表（/v1/models） | ✅ |
| 错误处理 | ✅ |
| 代理支持（proxiedFetch） | ✅ 复用现有 |
| 模型名透传 | ✅ |
| 元数据自动补齐 | ✅ |

## 9. 后续扩展（非首次范围）

| 特性 | 说明 |
|------|------|
| 会话自动刷新 | 浏览器自动化定期刷新 token_v2 |
| 对话续接 | 持久化 threadId，续接已有 Notion thread |
| 多账号池 | 多个 Probe JSON + 负载均衡 |
| Web 搜索 | 设置 searchScopes + useWebSearch |
| 文件上传 | 实现 getUploadFileUrl 流程 |
| 浏览器回退 | trust-rule-denied 时用 Playwright 兜底 |

## 10. 配置参考

```env
# Notion 渠道（可选）
# 指向一个有效的 Probe JSON 文件路径
# 未配置时 Notion 模型不可用
NOTION_PROBE_PATH=/data/notion_accounts/default/probe.json
```

### Probe JSON 文件示例

```json
{
  "email": "user@example.com",
  "user_id": "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
  "space_id": "abcdef1234567890abcdef1234567890",
  "client_version": "25.3.56.8",
  "cookies": [
    { "name": "token_v2", "value": "abc123def456..." }
  ]
}
```

---

## 附录：与现有渠道对比

| 维度 | DeepSeek | GLM | Notion（新增） |
|------|----------|-----|----------------|
| 认证方式 | API Token / 账号密码 | Refresh Token / 访客 | Cookie (token_v2) |
| 会话管理 | Token 池 + session 轮换 | Token 管理器 | Probe JSON 单会话 |
| 流式格式 | SSE (text/event-stream) | SSE (text/event-stream) | NDJSON (application/x-ndjson) |
| 请求头 | Bearer auth + browser mimic | Bearer auth | Cookie auth + full browser forgery |
| 模型名 | deepseek-* 前缀 | glm-* 前缀 | 直接使用真实模型名 |
| 请求体 | 简单 prompt + 可选参数 | 简单 prompt + 可选参数 | 复杂 transactions 结构 |
| 工具调用 | XML 注入 + 校验管线 | 兼容层 | 首次暂不支持 |
