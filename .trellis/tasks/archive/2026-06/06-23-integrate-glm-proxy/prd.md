# 统一多渠道 API 格式（OpenAI + Claude）

## Goal

为项目的所有 AI 渠道（DeepSeek、GLM、Gemini）统一实现标准的 OpenAI 和 Claude 两种 API 格式，符合互联网标准规范，确保所有渠道都能：
- 支持 OpenAI SDK 和 Claude SDK 客户端
- 支持 Tool Calling、MCP 工具、SKILLS 技能
- 提供一致的 API 体验

## Background

### 当前状态
- **DeepSeek 渠道**：
  - ✅ OpenAI 格式：`POST /v1/chat/completions`
  - ✅ DeepSeek 原生格式：`POST /api/v0/chat/completion`
  - ❌ Claude 格式：未实现
  
- **GLM 渠道**（`src/glm.js` 已实现核心功能）：
  - ✅ OpenAI 格式：已在 `glm.js` 实现
  - ❌ Claude 格式：未实现
  - ❌ 路由未注册到 `index.js`
  
- **Gemini 渠道**：
  - ⏸️ 第一期暂不实现，留待后续迭代

### 技术架构
- GLM 使用三层 Token 体系：访客 → refresh_token → access_token（1小时有效）
- GLM 支持访客模式（无需配置）和 refresh_token 模式（可选配置）
- 项目已有 OpenAI 格式的完整实现（Tool Calling、流式响应等）
- 需要实现 Claude 格式适配器（消息格式、SSE 事件转换）

## Requirements

### 统一路由设计

**重要**：所有路由遵循 `/{channel}/v1/{endpoint}` 格式，符合标准 baseURL 规范。

**第一期范围**：仅实现 DeepSeek 和 GLM 两个渠道，Gemini 渠道暂不实现。

为每个渠道提供标准的 OpenAI 和 Claude 格式端点：

#### DeepSeek 渠道
- `POST /deepseek/v1/chat/completions` — OpenAI 格式（新增）
- `POST /deepseek/v1/messages` — Claude 格式（新增）
- `GET /deepseek/v1/models` — 模型列表（新增）
- 保留现有端点以保证向后兼容：
  - `POST /v1/chat/completions` — 默认 DeepSeek（保留）
  - `POST /api/v0/chat/completion` — DeepSeek 原生格式（保留）

#### GLM 渠道
- `POST /glm/v1/chat/completions` — OpenAI 格式（新增）
- `POST /glm/v1/messages` — Claude 格式（新增）
- `GET /glm/v1/models` — 模型列表（新增）

**客户端配置示例**：
```javascript
// OpenAI SDK - GLM 渠道
const glmClient = new OpenAI({
  baseURL: 'http://localhost:3000/glm/v1',  // 渠道前缀 + /v1
  apiKey: 'your-api-key'
});

// Anthropic SDK - DeepSeek 渠道
const client = new Anthropic({
  baseURL: 'http://localhost:3000/deepseek/v1',  // 渠道前缀 + /v1
  apiKey: 'your-api-key'
});
```

### Claude 格式适配器

需要实现 Claude API 格式的完整支持：

#### 请求格式转换（Claude → OpenAI）
- `messages` 数组转换（`role: user/assistant`）
- `system` 参数提取并合并到消息
- `tool_use` 和 `tool_result` 转换为 OpenAI 的 `tool_calls` 和 `tool` role
- `max_tokens` 映射到 `max_tokens`
- `temperature` / `top_p` 参数透传

#### 响应格式转换（OpenAI → Claude）

**非流式响应**：
```javascript
{
  "id": "msg_...",
  "type": "message",
  "role": "assistant",
  "content": [
    { "type": "text", "text": "..." },
    { "type": "tool_use", "id": "...", "name": "...", "input": {...} }
  ],
  "model": "...",
  "stop_reason": "end_turn" | "tool_use" | "max_tokens",
  "usage": { "input_tokens": 0, "output_tokens": 0 }
}
```

**流式响应（SSE）**：
- `event: message_start` — 消息开始
- `event: content_block_start` — 内容块开始（text 或 tool_use）
- `event: content_block_delta` — 内容增量（text_delta 或 input_json_delta）
- `event: content_block_stop` — 内容块结束
- `event: message_delta` — 消息元数据更新（usage、stop_reason）
- `event: message_stop` — 消息结束

### 环境变量配置

在 `.env.example` 中添加 GLM 渠道配置：

```bash
# GLM（智谱清言）认证（可选，留空则使用访客模式）
# 访客模式：无需配置，自动获取临时 token
# 长期模式：配置 refresh_token 以保持长期访问
GLM_REFRESH_TOKEN=
```

注意：第一期不涉及 Gemini 配置。

### 代码架构

#### 新增文件
- `src/adapters/claude.js` — Claude 格式适配器
  - `convertClaudeRequest(claudeReq) → openaiReq`
  - `convertOpenAIResponse(openaiResp) → claudeResp`
  - `streamOpenAIToClaude(openaiStream) → claudeSSE`

#### 修改文件
- `src/index.js` — 注册所有新路由
- `src/openai.js` — 提取通用逻辑供适配器复用，新增 Claude 格式处理器
- `src/glm.js` — 新增 Claude 格式处理器

#### 暂不修改
- `src/gemini.js` — 第一期不实现 Gemini 渠道

## Acceptance Criteria

### 路由可用性
- [ ] DeepSeek 渠道支持 OpenAI 和 Claude 格式
  - [ ] `POST /deepseek/v1/chat/completions` 正常工作
  - [ ] `POST /deepseek/v1/messages` 正常工作
  - [ ] `GET /deepseek/v1/models` 返回模型列表
  - [ ] 现有端点 `/v1/chat/completions` 继续正常工作（向后兼容）
  
- [ ] GLM 渠道支持 OpenAI 和 Claude 格式
  - [ ] `POST /glm/v1/chat/completions` 正常工作（访客模式）
  - [ ] `POST /glm/v1/messages` 正常工作（访客模式）
  - [ ] `GET /glm/v1/models` 返回 GLM 模型列表

### Claude 格式兼容性
- [ ] 请求格式正确转换：
  - [ ] `messages` 数组转换
  - [ ] `system` 参数处理
  - [ ] `tool_use` / `tool_result` 转换
  - [ ] 参数映射（`max_tokens`、`temperature` 等）
  
- [ ] 非流式响应格式正确：
  - [ ] 响应结构符合 Claude API 规范
  - [ ] `content` 数组正确（text / tool_use）
  - [ ] `stop_reason` 正确映射
  - [ ] `usage` 统计正确
  
- [ ] 流式响应事件正确：
  - [ ] `message_start` 事件
  - [ ] `content_block_start` / `content_block_delta` / `content_block_stop` 事件序列
  - [ ] `message_delta` / `message_stop` 事件
  - [ ] 工具调用流式输出正确（`input_json_delta`）

### 工具调用支持
- [ ] OpenAI 格式的 Tool Calling 在 DeepSeek 和 GLM 渠道正常工作
- [ ] Claude 格式的 `tool_use` 在 DeepSeek 和 GLM 渠道正常工作
- [ ] 工具调用结果正确返回并可续接对话

### 配置和文档
- [ ] `.env.example` 包含 GLM 配置项
- [ ] 启动日志显示所有新增端点
- [ ] API Key 鉴权对所有新端点生效

### 代码质量
- [ ] 代码风格与现有项目一致
- [ ] Claude 适配器逻辑清晰，易于维护
- [ ] 复用现有代码，避免重复
- [ ] 错误处理健全

## Out of Scope

### 第一期不包含
- **Gemini 渠道**：完全不实现，包括：
  - Gemini OpenAI 格式端点
  - Gemini Claude 格式端点
  - Gemini 原生格式端点
  - `src/gemini.js` 的任何修改
- 修改 `.env` 文件中的真实凭证
- 添加 Claude/GLM 特有的高级功能（如 GLM 的图像/视频生成）
- 添加新的管理面板页面
- 性能优化或架构重构（除非必要）
- 支持 Claude 的 Prompt Caching、Citation 等高级特性
- 实现多渠道负载均衡或故障转移

### 向后兼容约束
- 必须保留现有端点，确保现有客户端不受影响：
  - `POST /v1/chat/completions` — 默认 DeepSeek
  - `POST /api/v0/chat/completion` — DeepSeek 原生格式
  - `GET /v1/models` — 当前模型列表

## Decisions

### 架构方案
- **决定**：采用方案 C — 为所有渠道统一实现 OpenAI + Claude 双格式
- **理由**：
  - 符合互联网标准规范
  - 确保所有渠道支持标准 SDK（OpenAI SDK、Claude SDK）
  - 统一支持 Tool Calling、MCP 工具、SKILLS 技能
  - 提供一致的 API 体验
- **实现方式**：通过适配器模式，将 Claude 格式转换为 OpenAI 格式，再调用各渠道的底层实现

### 监控和状态信息
- **决定**：暂时不为 GLM 单独添加状态监控
- **理由**：GLM 采用无状态的 Token 管理器，基本无需人工干预；可在后续迭代中根据实际使用情况再决定是否添加
- **后续可选**：如需监控，可统计 token 刷新次数、请求成功率等

### API Key 鉴权
- **决定**：所有新路由受现有的 `API_KEY` 环境变量保护，与现有路由保持一致
- **理由**：保持所有 API 端点的安全策略一致，便于运维管理；复用现有鉴权中间件
- **实现**：新路由注册在 API Key 中间件之后，自动应用 `Authorization: Bearer <API_KEY>` 验证

### 错误处理和日志
- **决定**：无需额外配置，复用现有的 `requestLogger` 中间件和各渠道内部错误处理
- **理由**：现有机制已覆盖请求日志、错误日志和性能指标；避免过度工程化
- **覆盖范围**：
  - 请求日志：`requestLogger` 自动记录所有新端点请求
  - 错误日志：各渠道内部的 `console.error` 记录关键错误
  - 性能指标：复用现有 `metrics.js` 机制

### 向后兼容性
- **决定**：保留所有现有端点，确保向后兼容
- **保留端点**：
  - `POST /v1/chat/completions` — 继续作为默认 DeepSeek 端点
  - `POST /api/v0/chat/completion` — DeepSeek 原生格式
  - `GET /v1/models` — 当前模型列表
- **新增端点**：使用渠道前缀区分（`/v1/{channel}/...`）

### Claude 适配器设计
- **决定**：创建独立的 Claude 适配器模块 `src/adapters/claude.js`
- **理由**：
  - 解耦格式转换逻辑与渠道实现
  - 便于复用和测试
  - 方便未来扩展其他格式（如 Cohere、Anthropic Vertex 等）
- **职责边界**：
  - 适配器只负责格式转换
  - 渠道处理器负责实际调用（DeepSeek、GLM、Gemini）

### 模型名称映射
- **决定**：保持渠道独立的模型名称，不做跨渠道统一映射
- **理由**：
  - 避免歧义（不同渠道的 "pro" 模型能力完全不同）
  - 让用户明确知道调用的是哪个渠道的模型
  - 简化实现，减少维护成本
  - 符合各渠道官方 API 的设计
- **实现**：
  - `/v1/deepseek/chat/completions` 只接受 DeepSeek 模型名
  - `/v1/glm/chat/completions` 只接受 GLM 模型名
  - `/v1/gemini/chat/completions` 只接受 Gemini 模型名
  - 在启动日志和文档中列出每个渠道支持的模型

### Gemini 原生格式
- **决定**：第一期完全不实现 Gemini 渠道
- **理由**：
  - 聚焦于 DeepSeek 和 GLM 两个核心渠道
  - 减少第一期工作量和复杂度
  - Gemini 可作为第二期独立任务
- **后续计划**：第二期可考虑添加 Gemini 渠道（基于 DeepSeek 底层或独立实现）

## Open Questions

无待解决问题。所有关键决策已确认：
- ✅ 采用方案 C：为所有渠道统一实现 OpenAI + Claude 双格式
- ✅ 移除 Gemini 原生格式支持
- ✅ 保持渠道独立的模型名称
- ✅ 复用现有鉴权、日志和错误处理机制
- ✅ 暂不添加 GLM 状态监控
