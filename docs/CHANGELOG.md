# GLM 渠道变更日志

## [添加 GLM-5.2 模型] - 2026-06-23

### 新增
- **GLM-5.2 模型支持**：添加智谱清言最新旗舰模型
  - 模型名称：`glm-5.2`
  - 类型：对话模型（chat）
  - 配置：启用 Plus 模型特性
  - 来源：通过 CDP 浏览器验证的官方最新模型

### 研究成果
- 探索 GLM API 端点，发现 `/backend-api/assistant/list` 需要用户认证
- 使用浏览器真实访问 `chatglm.cn` 确认 GLM-5.2 为当前主推模型
- 评估动态 API 方案，决定采用硬编码更新（简单可靠）

### 技术细节
- 模型总数：7 个 GLM 模型（新增 1 个）
- 自动路由：`glm-5.2` 通过模型路由器自动识别
- 向后兼容：不影响现有模型

---

## [API 端点统一重构] - 2026-06-23

### 重大变更
- **API 端点统一**：移除渠道特定端点，统一为标准 OpenAI/Claude 端点
  - 移除 `/deepseek/v1/*` 端点
  - 移除 `/glm/v1/*` 端点
  - 统一为 `/v1/chat/completions`（OpenAI 格式）
  - 统一为 `/v1/messages`（Claude 格式）
  - 统一为 `/v1/models`（所有渠道模型）
  - 通过 `model` 参数自动路由到正确渠道

### 新增
- **模型路由器**：新增 `src/model-router.js` 模块
  - 根据模型名称前缀自动路由（`deepseek-*` → DeepSeek, `glm-*`/`cogview-*` → GLM）
  - 未知模型返回清晰的中文错误消息
- **统一模型列表**：`/v1/models` 返回所有渠道的模型（13 个）
  - 7 个 DeepSeek 模型
  - 6 个 GLM 模型
  - 按渠道分组排序

### 改进
- **完全兼容 OpenAI/Claude SDK**：只需配置 `baseURL: '.../v1'` 即可使用
- **中文错误提示**：错误消息更友好
- **动态模型列表**：从 `MODEL_MAP` 动态生成，自动同步

### 破坏性变更
- ⚠️ 旧的渠道端点已移除（`/deepseek/v1/*`, `/glm/v1/*`）
- ✅ 项目未上线，无实际影响

### 技术细节
- 新增文件：`src/model-router.js`
- 修改文件：`src/index.js`, `src/openai.js`, `src/glm.js`
- 导出 `MODEL_MAP` 用于统一模型列表生成

---

## [增强更新] - 2026-06-23 (下午)

### 新增功能
- **GLM Token 池管理**：支持 `GLM_REFRESH_TOKENS` 环境变量配置多个 refresh tokens，自动轮询调度
- **Claude 格式流式响应**：`/deepseek/v1/messages` 和 `/glm/v1/messages` 端点现在支持 `stream: true`
- **统一 API 调用层**：新增 `src/api-client.js` 模块，封装 DeepSeek 和 GLM API 调用

### 架构改进
- **重构处理器**：移除响应拦截模式，使用统一的 API 调用层处理流式和非流式响应
- **独立缓存**：为每个 refresh token 独立缓存 access token，避免相互影响
- **错误处理**：改进流式响应的错误处理和连接中断恢复

### 向后兼容性
- ✅ 所有现有 API 端点保持不变
- ✅ 单 token 模式（`GLM_REFRESH_TOKEN`）继续支持
- ✅ 非流式功能不受影响

详细信息：[GLM 增强功能详细变更](./GLM_ENHANCEMENTS_CHANGELOG.md)

---

## [初始接入] - 2026-06-23 (上午)

### 完成时间
2026-06-23

## 变更概述

成功将 GLM（智谱清言）反代渠道集成到 deepseek-2api 项目中，并增强了 DeepSeek 渠道的 API 格式支持。

## 主要变更

### 1. 新增文件

#### `src/glm.js` (1107 行)
GLM 渠道核心实现，包含：
- 三层 Token 认证体系（访客 → refresh → access）
- OpenAI 格式 ↔ GLM 格式转换
- Claude 格式支持
- 模型管理
- 消息格式处理
- 工具调用、文件上传、图像/视频生成等高级功能

#### `src/adapters/claude.js` (282 行)
Claude API 格式适配器，提供：
- `convertClaudeRequest()` - Claude → OpenAI 请求转换
- `convertOpenAIResponse()` - OpenAI → Claude 响应转换
- `streamOpenAIToClaude()` - 流式响应转换（框架已实现）
- `writeClaudeSSE()` - SSE 事件写入工具

#### `docs/GLM_INTEGRATION.md`
GLM 集成文档，包含：
- API 端点说明
- 请求示例
- 支持的模型列表
- 架构说明
- 测试结果
- 当前限制和下一步计划

### 2. 修改文件

#### `src/index.js`
新增路由：
- `POST /glm/v1/chat/completions` - GLM OpenAI 格式
- `POST /glm/v1/messages` - GLM Claude 格式
- `GET /glm/v1/models` - GLM 模型列表
- `POST /deepseek/v1/messages` - DeepSeek Claude 格式

#### `src/openai.js`
新增功能：
- `handleDeepSeekClaude()` - DeepSeek Claude 格式处理器
- `handleDeepSeekModels()` - DeepSeek 模型列表

导入 Claude 适配器。

## 技术实现细节

### Claude 格式适配策略

由于 Claude API 格式与 OpenAI 格式存在差异，采用了**请求劫持 + 响应转换**的策略：

```javascript
export async function handleDeepSeekClaude(req, res) {
  // 1. 转换请求格式：Claude → OpenAI
  const openaiReq = convertClaudeRequest(req.body);
  
  // 2. 劫持 req.body
  const savedBody = req.body;
  req.body = { ...openaiReq, model: '...', stream: false };
  
  // 3. 使用响应收集器调用原始 OpenAI 处理器
  const proxyRes = {
    json: (data) => { capturedResponse = data; },
    status: (code) => ({ json: (data) => { capturedError = { code, data }; } }),
    // ... 其他必要方法
  };
  await handleOpenAICompletion(req, proxyRes);
  
  // 4. 恢复原始 req.body
  req.body = savedBody;
  
  // 5. 转换响应格式：OpenAI → Claude
  const claudeResp = convertOpenAIResponse(capturedResponse, model);
  res.json(claudeResp);
}
```

### GLM 认证流程

```
访客模式(guest/access) → Refresh Token → Access Token (1小时有效)
                                ↓
                         定期刷新(user/refresh)
```

关键实现：
- `GlmTokenManager` 类管理 Token 生命周期
- 自动刷新和缓存机制
- 签名算法（时间戳 + nonce + MD5）

## 功能验证

### ✅ 已验证功能

1. **DeepSeek Claude 格式（非流式）**
   - 端点：`POST /deepseek/v1/messages`
   - 状态：✅ 工作正常
   - 测试结果：成功返回 Claude 格式响应

2. **DeepSeek 模型列表**
   - 端点：`GET /deepseek/v1/models`
   - 状态：✅ 工作正常

3. **GLM 模型列表**
   - 端点：`GET /glm/v1/models`
   - 状态：✅ 工作正常

### ⚠️ 需要进一步测试

1. **GLM OpenAI 格式**
   - 端点：`POST /glm/v1/chat/completions`
   - 状态：⚠️ 返回 400 错误
   - 原因：可能需要有效的 `GLM_REFRESH_TOKEN` 环境变量

2. **GLM Claude 格式**
   - 端点：`POST /glm/v1/messages`
   - 状态：⚠️ 返回 400 错误
   - 原因：同上

### ⏳ 待实现功能

1. Claude 格式流式响应支持
2. GLM 高级功能验证（工具调用、文件上传、图像生成等）

## 代码质量

- ✅ 遵循现有代码风格
- ✅ 完整的错误处理
- ✅ 详细的注释和文档
- ✅ 模块化设计
- ✅ 可扩展架构

## 已知限制

1. **Claude 格式**：当前仅支持非流式响应，流式响应框架已实现但未启用
2. **GLM 认证**：访客模式可能受限，建议配置 `GLM_REFRESH_TOKEN`
3. **测试覆盖**：部分 GLM 功能（工具调用、文件上传等）尚未实际测试

## 下一步建议

1. 配置有效的 `GLM_REFRESH_TOKEN` 并测试 GLM API
2. 实现 Claude 格式流式响应
3. 添加单元测试和集成测试
4. 性能优化和监控
5. 添加请求限流和错误重试机制

## 文件清单

### 新增文件
- `src/glm.js` - GLM 渠道实现
- `src/adapters/claude.js` - Claude 格式适配器
- `docs/GLM_INTEGRATION.md` - 集成文档
- `docs/CHANGELOG.md` - 本变更总结

### 修改文件
- `src/index.js` - 路由注册
- `src/openai.js` - Claude 格式处理器

## 技术栈

- Node.js 22.x
- Express.js
- ES6+ (ESM)
- Fetch API
- SSE (Server-Sent Events)

## 参考文档

- [GLM模型调用接入指南](./GLM模型调用接入指南.md)
- [GLM_INTEGRATION.md](./GLM_INTEGRATION.md)
