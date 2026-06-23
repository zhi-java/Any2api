# 实施计划：统一多渠道 API 格式

## 概述

本任务将为 DeepSeek 和 GLM 两个渠道实现 OpenAI 和 Claude 双格式支持。

**核心目标**：
1. 创建 Claude 格式适配器
2. 为 DeepSeek 和 GLM 添加 Claude 格式处理器
3. 注册新路由（格式：`/{channel}/v1/{endpoint}`）
4. 保持向后兼容

**预计工作量**：3-5 天

---

## 实施步骤

### 阶段 1：Claude 适配器实现（核心）

#### 1.1 创建适配器目录和文件

```bash
mkdir -p src/adapters
touch src/adapters/claude.js
```

#### 1.2 实现请求格式转换

**文件**：`src/adapters/claude.js`

**功能**：实现 `convertClaudeRequest` 函数

核心逻辑：
- Claude `messages` → OpenAI `messages`
- Claude `system` → 合并到 OpenAI messages
- Claude `tool_use`/`tool_result` → OpenAI `tool_calls`/`tool` role
- 参数映射：`max_tokens`, `temperature`, `top_p`

**验证命令**：
```bash
node -e "import('./src/adapters/claude.js').then(m => console.log(m.convertClaudeRequest({messages:[{role:'user',content:'test'}]})))"
```

#### 1.3 实现非流式响应转换

**功能**：实现 `convertOpenAIResponse` 函数

核心逻辑：
- OpenAI `choices[0].message` → Claude `content` 数组
- `message.content` → `{type: 'text', text: ...}`
- `message.tool_calls` → `{type: 'tool_use', ...}`
- `finish_reason` 映射：`stop` → `end_turn`, `tool_calls` → `tool_use`

**验证命令**：
```bash
# 运行单元测试
node test/adapters/claude.test.js
```

#### 1.4 实现流式响应转换

**功能**：实现 `streamOpenAIToClaude` 生成器函数

核心逻辑：
- 发送 `message_start` 事件
- OpenAI delta → Claude `content_block_delta` 事件
- 处理工具调用的增量式输出
- 发送 `message_stop` 事件

**验证命令**：
```bash
# 集成测试（需要启动服务）
curl -X POST http://localhost:3000/deepseek/v1/messages \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $API_KEY" \
  -d '{"model":"deepseek-v4-flash","messages":[{"role":"user","content":"test"}],"stream":true}'
```

---

### 阶段 2：DeepSeek 渠道 Claude 支持

#### 2.1 修改 src/openai.js

**新增函数**：`handleDeepSeekClaude`

```javascript
export async function handleDeepSeekClaude(req, res) {
  const claudeReq = req.body;
  const openaiReq = convertClaudeRequest(claudeReq);
  
  // 创建虚拟请求
  const virtualReq = { ...req, body: openaiReq };
  
  if (openaiReq.stream) {
    // 流式：拦截并转换
    const openaiStream = await getDeepSeekStream(virtualReq);
    await streamClaudeResponse(res, openaiStream, claudeReq.model);
  } else {
    // 非流式
    const openaiResp = await getDeepSeekResponse(virtualReq);
    const claudeResp = convertOpenAIResponse(openaiResp, claudeReq.model);
    res.json(claudeResp);
  }
}
```

**新增函数**：`handleDeepSeekModels`

```javascript
export function handleDeepSeekModels(req, res) {
  const models = Object.keys(MODEL_MAP).map(id => ({
    id,
    object: 'model',
    created: 1700000000,
    owned_by: 'deepseek',
  }));
  res.json({ object: 'list', data: models });
}
```

**验证命令**：
```bash
# 测试 DeepSeek Claude 格式
curl -X POST http://localhost:3000/deepseek/v1/messages \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $API_KEY" \
  -d '{"model":"deepseek-v4-flash","messages":[{"role":"user","content":"Hello"}]}'

# 测试模型列表
curl http://localhost:3000/deepseek/v1/models \
  -H "Authorization: Bearer $API_KEY"
```

---

### 阶段 3：GLM 渠道 Claude 支持

#### 3.1 修改 src/glm.js

**新增导出**：
```javascript
// 已有的 OpenAI 格式处理器重命名
export { handleGLMCompletion as handleGLMOpenAI };
export { handleGLMModels };
```

**新增函数**：`handleGLMClaude`

```javascript
export async function handleGLMClaude(req, res) {
  const claudeReq = req.body;
  const openaiReq = convertClaudeRequest(claudeReq);
  
  // 复用 GLM OpenAI 格式处理逻辑
  const virtualReq = { ...req, body: openaiReq };
  
  if (openaiReq.stream) {
    const glmStream = await getGLMStream(virtualReq);
    await streamClaudeResponse(res, glmStream, claudeReq.model);
  } else {
    const glmResp = await getGLMResponse(virtualReq);
    const claudeResp = convertOpenAIResponse(glmResp, claudeReq.model);
    res.json(claudeResp);
  }
}
```

**验证命令**：
```bash
# 测试 GLM Claude 格式（访客模式）
curl -X POST http://localhost:3000/glm/v1/messages \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $API_KEY" \
  -d '{"model":"glm-4","messages":[{"role":"user","content":"你好"}]}'

# 测试 GLM OpenAI 格式
curl -X POST http://localhost:3000/glm/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $API_KEY" \
  -d '{"model":"glm-4","messages":[{"role":"user","content":"你好"}]}'
```

---

### 阶段 4：路由注册

#### 4.1 修改 src/index.js

**在鉴权中间件之后添加新路由**：

```javascript
// 在文件顶部添加导入
import { handleDeepSeekClaude, handleDeepSeekModels } from './openai.js';
import { handleGLMOpenAI, handleGLMClaude, handleGLMModels } from './glm.js';

// 在现有路由之后添加
// ============= DeepSeek 渠道 =============
app.post('/deepseek/v1/chat/completions', handleOpenAICompletion); // 复用现有处理器
app.post('/deepseek/v1/messages', handleDeepSeekClaude);
app.get('/deepseek/v1/models', handleDeepSeekModels);

// ============= GLM 渠道 =============
app.post('/glm/v1/chat/completions', handleGLMOpenAI);
app.post('/glm/v1/messages', handleGLMClaude);
app.get('/glm/v1/models', handleGLMModels);
```

**更新启动日志**：

```javascript
app.listen(PORT, async () => {
  console.log(`DeepSeek 2API running on http://localhost:${PORT}`);
  console.log(`OpenAI format:  POST /v1/chat/completions`);
  console.log(`DeepSeek format: POST /api/v0/chat/completion`);
  console.log(`Models: GET /v1/models`);
  
  // 新增 DeepSeek 渠道日志
  console.log(`\nDeepSeek channel:`);
  console.log(`  OpenAI:  POST /deepseek/v1/chat/completions`);
  console.log(`  Claude:  POST /deepseek/v1/messages`);
  console.log(`  Models:  GET /deepseek/v1/models`);
  
  // 新增 GLM 渠道日志
  console.log(`\nGLM channel:`);
  console.log(`  OpenAI:  POST /glm/v1/chat/completions`);
  console.log(`  Claude:  POST /glm/v1/messages`);
  console.log(`  Models:  GET /glm/v1/models`);
  
  console.log(`\nAdmin panel: http://localhost:${PORT}/admin`);
  // ... 现有代码 ...
});
```

**验证命令**：
```bash
npm start
# 检查启动日志是否包含所有新增端点
```

---

### 阶段 5：环境变量配置

#### 5.1 修改 .env.example

**在 DeepSeek 配置区域之后添加**：

```bash
# GLM（智谱清言）认证（可选，留空则使用访客模式）
# 访客模式：无需配置，自动获取临时 token
# 长期模式：配置 refresh_token 以保持长期访问
# 获取方式：参考 docs/GLM模型调用接入指南.md
GLM_REFRESH_TOKEN=
```

**验证**：
- 确认 `.env` 文件未被修改
- 确认 `.env.example` 已更新

---

### 阶段 6：集成测试

#### 6.1 功能测试清单

**DeepSeek OpenAI 格式**：
```bash
# 非流式
curl -X POST http://localhost:3000/deepseek/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $API_KEY" \
  -d '{"model":"deepseek-v4-flash","messages":[{"role":"user","content":"1+1=?"}],"stream":false}'

# 流式
curl -X POST http://localhost:3000/deepseek/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $API_KEY" \
  -d '{"model":"deepseek-v4-flash","messages":[{"role":"user","content":"1+1=?"}],"stream":true}'
```

**DeepSeek Claude 格式**：
```bash
# 非流式
curl -X POST http://localhost:3000/deepseek/v1/messages \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $API_KEY" \
  -H "anthropic-version: 2023-06-01" \
  -d '{"model":"deepseek-v4-flash","messages":[{"role":"user","content":"1+1=?"}],"max_tokens":1024}'

# 流式
curl -X POST http://localhost:3000/deepseek/v1/messages \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $API_KEY" \
  -H "anthropic-version: 2023-06-01" \
  -d '{"model":"deepseek-v4-flash","messages":[{"role":"user","content":"1+1=?"}],"max_tokens":1024,"stream":true}'
```

**GLM OpenAI 格式**：
```bash
curl -X POST http://localhost:3000/glm/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $API_KEY" \
  -d '{"model":"glm-4","messages":[{"role":"user","content":"你好，请介绍一下你自己"}]}'
```

**GLM Claude 格式**：
```bash
curl -X POST http://localhost:3000/glm/v1/messages \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $API_KEY" \
  -H "anthropic-version: 2023-06-01" \
  -d '{"model":"glm-4","messages":[{"role":"user","content":"你好，请介绍一下你自己"}],"max_tokens":1024}'
```

**工具调用测试**：
```bash
# DeepSeek Claude 格式 + 工具调用
curl -X POST http://localhost:3000/deepseek/v1/messages \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $API_KEY" \
  -H "anthropic-version: 2023-06-01" \
  -d '{
    "model":"deepseek-v4-flash",
    "messages":[{"role":"user","content":"北京今天天气如何？"}],
    "max_tokens":1024,
    "tools":[{
      "name":"get_weather",
      "description":"获取指定城市的天气",
      "input_schema":{
        "type":"object",
        "properties":{"city":{"type":"string"}},
        "required":["city"]
      }
    }]
  }'
```

**向后兼容测试**：
```bash
# 确认现有端点仍然工作
curl -X POST http://localhost:3000/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $API_KEY" \
  -d '{"model":"deepseek-v4-flash","messages":[{"role":"user","content":"test"}]}'
```

#### 6.2 错误场景测试

```bash
# 无 API Key
curl -X POST http://localhost:3000/glm/v1/messages \
  -H "Content-Type: application/json" \
  -d '{"model":"glm-4","messages":[{"role":"user","content":"test"}]}'
# 期望：401 Unauthorized

# 错误的模型名称
curl -X POST http://localhost:3000/deepseek/v1/messages \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $API_KEY" \
  -d '{"model":"nonexistent-model","messages":[{"role":"user","content":"test"}]}'
# 期望：400 Bad Request

# 缺少必需参数
curl -X POST http://localhost:3000/glm/v1/messages \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $API_KEY" \
  -d '{"model":"glm-4"}'
# 期望：400 Bad Request (messages required)
```

---

## 验收检查清单

### 功能验收
- [ ] DeepSeek OpenAI 格式端点正常工作（`/deepseek/v1/chat/completions`）
- [ ] DeepSeek Claude 格式端点正常工作（`/deepseek/v1/messages`）
- [ ] GLM OpenAI 格式端点正常工作（`/glm/v1/chat/completions`）
- [ ] GLM Claude 格式端点正常工作（`/glm/v1/messages`）
- [ ] 模型列表端点正常工作（`/deepseek/v1/models`, `/glm/v1/models`）
- [ ] 流式和非流式响应都正常
- [ ] 工具调用功能正常（OpenAI 和 Claude 格式）
- [ ] 现有端点向后兼容（`/v1/chat/completions` 等）

### 格式验收
- [ ] Claude 请求格式正确转换为 OpenAI 格式
- [ ] OpenAI 响应格式正确转换为 Claude 格式
- [ ] Claude SSE 事件序列正确（message_start → content_block_* → message_stop）
- [ ] 工具调用的 Claude 格式转换正确

### 配置验收
- [ ] `.env.example` 包含 GLM 配置说明
- [ ] 启动日志显示所有新增端点
- [ ] API Key 鉴权对所有新端点生效

### 代码质量验收
- [ ] 代码风格与现有项目一致
- [ ] 无明显的代码重复
- [ ] 错误处理健全
- [ ] 关键函数有注释说明

---

## 风险点和注意事项

### 风险点

1. **Claude SSE 事件顺序**：必须严格按照 Claude API 规范发送事件
2. **工具调用增量式输出**：需要正确处理 `input_json_delta`
3. **GLM 访客模式 Token 刷新**：确保访客模式下 token 自动刷新正常
4. **向后兼容性**：现有端点行为必须保持不变

### 注意事项

1. **路由格式**：必须是 `/{channel}/v1/{endpoint}`，不是 `/v1/{channel}/{endpoint}`
2. **模型名称**：各渠道使用独立的模型名称，不做跨渠道映射
3. **错误格式**：Claude 格式的错误响应结构与 OpenAI 不同
4. **API Key 鉴权**：所有新端点必须在鉴权中间件之后注册

---

## 回滚方案

如果发现严重问题需要回滚：

1. **移除新增路由**：注释或删除 `src/index.js` 中的新路由注册
2. **保留适配器文件**：不删除 `src/adapters/claude.js`，便于后续修复
3. **恢复启动日志**：移除新增的日志输出
4. **保留 .env.example**：配置项保留，标注为「待实现」

**回滚后影响**：
- 现有端点（`/v1/chat/completions` 等）不受影响
- 新端点（`/{channel}/v1/*`）无法访问
- GLM 渠道完全不可用（因为路由未注册）

---

## 后续优化方向

完成第一期后，可考虑：

1. **Gemini 渠道**：添加 Gemini 渠道的 OpenAI + Claude 双格式支持
2. **性能优化**：适配器转换性能优化、响应缓存
3. **监控增强**：添加各渠道的调用统计和错误监控
4. **测试覆盖**：完善单元测试和集成测试
5. **文档完善**：编写 API 使用文档和示例代码
