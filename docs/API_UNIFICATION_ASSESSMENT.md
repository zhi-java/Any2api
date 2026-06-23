# API 端点统一重构 - 评估报告

## 当前架构分析

### 现有端点结构（按渠道分离）

```
当前设计：
/v1/chat/completions           → DeepSeek (默认)
/v1/models                     → DeepSeek (默认)

/deepseek/v1/chat/completions  → DeepSeek OpenAI 格式
/deepseek/v1/messages          → DeepSeek Claude 格式
/deepseek/v1/models            → DeepSeek 模型列表

/glm/v1/chat/completions       → GLM OpenAI 格式
/glm/v1/messages               → GLM Claude 格式
/glm/v1/models                 → GLM 模型列表

/api/v0/chat/completion        → 旧版端点（已废弃）
```

### 问题识别

#### 1. 不符合 OpenAI/Claude 标准
**标准格式**：
- OpenAI: `POST /v1/chat/completions` + `model` 参数
- Claude: `POST /v1/messages` + `model` 参数

**当前问题**：
- ❌ 使用渠道前缀（`/deepseek/v1/...`, `/glm/v1/...`）
- ❌ 违反 OpenAI/Claude SDK 的默认端点
- ❌ 客户端需要为每个渠道配置不同的 base URL

#### 2. 模型列表重复
```
/v1/models           → 只返回 DeepSeek 模型
/deepseek/v1/models  → 返回 DeepSeek 模型
/glm/v1/models       → 返回 GLM 模型
```

**问题**：
- 用户无法在一个端点看到所有可用模型
- 不符合标准：`GET /v1/models` 应返回所有模型

#### 3. 模型名称冲突风险
如果合并端点，不同渠道的模型可能重名：
- DeepSeek: `deepseek-v4-flash`
- GLM: `glm-4-flash`

**需要**：清晰的模型命名约定

---

## 统一方案设计

### 方案 A: 标准 OpenAI/Claude 端点 + 模型前缀（推荐）

#### 端点结构

```
统一端点：
POST /v1/chat/completions      → OpenAI 格式（所有渠道）
POST /v1/messages              → Claude 格式（所有渠道）
GET  /v1/models                → 所有渠道的模型列表
```

#### 模型命名约定

```json
{
  "data": [
    // DeepSeek 渠道
    {"id": "deepseek-v4-flash", "object": "model", "owned_by": "deepseek"},
    {"id": "deepseek-v4", "object": "model", "owned_by": "deepseek"},
    {"id": "deepseek-reasoner", "object": "model", "owned_by": "deepseek"},
    
    // GLM 渠道
    {"id": "glm-4", "object": "model", "owned_by": "zhipu"},
    {"id": "glm-4-plus", "object": "model", "owned_by": "zhipu"},
    {"id": "glm-4-flash", "object": "model", "owned_by": "zhipu"},
    {"id": "glm-4v", "object": "model", "owned_by": "zhipu"}
  ]
}
```

#### 使用示例

```bash
# OpenAI 格式 - DeepSeek
curl -X POST https://api.example.com/v1/chat/completions \
  -H "Authorization: Bearer sk-xxx" \
  -d '{"model": "deepseek-v4-flash", "messages": [...]}'

# OpenAI 格式 - GLM
curl -X POST https://api.example.com/v1/chat/completions \
  -H "Authorization: Bearer sk-xxx" \
  -d '{"model": "glm-4", "messages": [...]}'

# Claude 格式 - DeepSeek
curl -X POST https://api.example.com/v1/messages \
  -H "Authorization: Bearer sk-xxx" \
  -H "anthropic-version: 2023-06-01" \
  -d '{"model": "deepseek-v4-flash", "messages": [...]}'

# Claude 格式 - GLM
curl -X POST https://api.example.com/v1/messages \
  -H "Authorization: Bearer sk-xxx" \
  -H "anthropic-version: 2023-06-01" \
  -d '{"model": "glm-4", "messages": [...]}'
```

#### 优点
- ✅ 符合 OpenAI/Claude 标准
- ✅ SDK 开箱即用（只需配置 base URL）
- ✅ 统一的模型列表
- ✅ 通过 model 参数自动路由到正确渠道

#### 缺点
- ⚠️ 需要实现模型名称 → 渠道的路由逻辑
- ⚠️ 破坏性变更（现有客户端需要更新）

---

### 方案 B: 保留渠道端点 + 新增统一端点（兼容方案）

#### 端点结构

```
统一端点（新增）：
POST /v1/chat/completions      → 根据 model 自动路由
POST /v1/messages              → 根据 model 自动路由
GET  /v1/models                → 所有模型

渠道端点（保留，向后兼容）：
POST /deepseek/v1/chat/completions
POST /deepseek/v1/messages
GET  /deepseek/v1/models

POST /glm/v1/chat/completions
POST /glm/v1/messages
GET  /glm/v1/models
```

#### 优点
- ✅ 向后兼容（旧端点继续工作）
- ✅ 支持标准客户端
- ✅ 平滑迁移

#### 缺点
- ⚠️ 代码维护复杂（两套端点）
- ⚠️ API 文档混乱

---

### 方案 C: 统一端点 + 渠道别名（最灵活）

#### 端点结构

```
主端点：
POST /v1/chat/completions      → 所有渠道
POST /v1/messages              → 所有渠道
GET  /v1/models                → 所有模型

渠道别名（简单重定向）：
POST /deepseek/v1/chat/completions → 重定向到 /v1/chat/completions
POST /glm/v1/chat/completions      → 重定向到 /v1/chat/completions
```

#### 模型别名支持

```json
// 主模型名
"deepseek-v4-flash"

// 别名（自动识别）
"deepseek:v4-flash"         → deepseek-v4-flash
"v4-flash"                  → deepseek-v4-flash (如果唯一)
"glm-4"                     → glm-4
"glm:4"                     → glm-4
```

#### 优点
- ✅ 最大灵活性
- ✅ 支持多种模型命名方式
- ✅ 渠道端点变为简单别名

#### 缺点
- ⚠️ 模型解析逻辑复杂

---

## 实施计划

### 推荐方案：A（标准端点 + 模型前缀）

#### Phase 1: 核心重构

**1.1 创建模型路由器**
```javascript
// src/model-router.js
export function routeModel(modelName) {
  // DeepSeek 模型
  if (modelName.startsWith('deepseek-')) {
    return { channel: 'deepseek', model: modelName };
  }
  
  // GLM 模型
  if (modelName.startsWith('glm-')) {
    return { channel: 'glm', model: modelName };
  }
  
  // 未知模型
  throw new Error(`Unknown model: ${modelName}`);
}
```

**1.2 统一处理器**
```javascript
// src/index.js
app.post('/v1/chat/completions', async (req, res) => {
  const { model } = req.body;
  
  // 路由到正确渠道
  const route = routeModel(model);
  
  if (route.channel === 'deepseek') {
    return handleOpenAICompletion(req, res);
  } else if (route.channel === 'glm') {
    return handleGLMOpenAI(req, res);
  }
});

app.post('/v1/messages', async (req, res) => {
  const { model } = req.body;
  
  // 路由到正确渠道
  const route = routeModel(model);
  
  if (route.channel === 'deepseek') {
    return handleDeepSeekClaude(req, res);
  } else if (route.channel === 'glm') {
    return handleGLMClaude(req, res);
  }
});
```

**1.3 统一模型列表**
```javascript
app.get('/v1/models', async (req, res) => {
  const deepseekModels = await getDeepSeekModels();
  const glmModels = await getGLMModels();
  
  res.json({
    object: 'list',
    data: [...deepseekModels, ...glmModels]
  });
});
```

#### Phase 2: 向后兼容（可选）

保留旧端点 30-90 天，返回迁移提示：

```javascript
app.post('/deepseek/v1/chat/completions', (req, res) => {
  res.setHeader('X-Deprecated', 'Use /v1/chat/completions instead');
  res.setHeader('X-Sunset', '2026-09-23');
  
  // 继续处理请求
  return handleOpenAICompletion(req, res);
});
```

#### Phase 3: 文档更新

- 更新 API 文档
- 添加迁移指南
- 更新 README

---

## 影响分析

### 破坏性变更

#### 受影响的客户端

```javascript
// 旧配置（需要更新）
const client = new OpenAI({
  baseURL: 'https://api.example.com/deepseek/v1',  // ❌ 旧端点
  apiKey: 'sk-xxx'
});

// 新配置
const client = new OpenAI({
  baseURL: 'https://api.example.com/v1',  // ✅ 标准端点
  apiKey: 'sk-xxx'
});

// 模型名称不变
await client.chat.completions.create({
  model: 'deepseek-v4-flash',  // ✅ 保持不变
  messages: [...]
});
```

#### 迁移成本

| 客户端类型 | 迁移成本 | 说明 |
|-----------|---------|------|
| OpenAI SDK | 低 | 只需更新 baseURL |
| Claude SDK | 低 | 只需更新 baseURL |
| 自定义客户端 | 中 | 需要修改端点路径 |
| 硬编码 URL | 高 | 需要代码修改和部署 |

### 优势

#### 1. 标准兼容性
- ✅ 任何 OpenAI SDK 可以直接使用
- ✅ 任何 Claude SDK 可以直接使用
- ✅ 符合行业标准

#### 2. 用户体验
- ✅ 单一端点，简单配置
- ✅ 统一的模型列表
- ✅ 更容易理解和使用

#### 3. 代码维护
- ✅ 减少重复代码
- ✅ 统一的路由逻辑
- ✅ 更容易添加新渠道

---

## 风险评估

### 高风险

1. **破坏现有客户端**
   - **风险**: 所有现有用户需要更新配置
   - **缓解**: 保留旧端点 30-90 天，提供迁移指南

2. **模型名称冲突**
   - **风险**: 不同渠道可能有同名模型
   - **缓解**: 强制模型名称包含渠道前缀

### 中风险

1. **路由逻辑复杂度**
   - **风险**: 模型 → 渠道的映射可能出错
   - **缓解**: 完整的单元测试

2. **性能影响**
   - **风险**: 额外的路由层增加延迟
   - **缓解**: 使用简单的字符串匹配（< 1ms）

### 低风险

1. **文档更新工作量**
   - **风险**: 需要更新所有文档
   - **缓解**: 逐步更新，优先更新主文档

---

## 建议

### 推荐采用：方案 A（标准端点 + 模型前缀）

**理由**：
1. ✅ 完全符合 OpenAI/Claude 标准
2. ✅ 长期维护成本最低
3. ✅ 用户体验最佳
4. ✅ 易于扩展新渠道

**实施策略**：
1. **Phase 1**（2-3 小时）：实现统一端点
2. **Phase 2**（1 小时）：保留旧端点 + 废弃警告
3. **Phase 3**（1 小时）：更新文档
4. **总计**: 约 4-5 小时

**迁移时间线**：
- **Day 1**: 部署新端点，旧端点标记为废弃
- **Day 30**: 发送迁移提醒邮件
- **Day 60**: 再次提醒
- **Day 90**: 移除旧端点

---

## 下一步

是否创建 Trellis 任务开始实施此重构？

**任务范围**：
- 创建模型路由器
- 统一 `/v1/chat/completions` 和 `/v1/messages`
- 统一 `/v1/models`
- 保留旧端点（带废弃警告）
- 更新文档

**预计时间**: 4-5 小时
