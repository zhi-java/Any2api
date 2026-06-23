# API 端点统一重构 - 技术设计

## 架构概览

### 当前架构（按渠道分离）

```
客户端
  ↓
/deepseek/v1/chat/completions → handleOpenAICompletion (DeepSeek)
/glm/v1/chat/completions      → handleGLMOpenAI (GLM)
/deepseek/v1/messages         → handleDeepSeekClaude (DeepSeek)
/glm/v1/messages              → handleGLMClaude (GLM)
```

**问题**：
- 每个渠道独立的端点路径
- 不符合 OpenAI/Claude 标准
- SDK 需要配置不同的 base URL

### 目标架构（统一端点）

```
客户端
  ↓
/v1/chat/completions → 模型路由器 → handleOpenAICompletion 或 handleGLMOpenAI
/v1/messages         → 模型路由器 → handleDeepSeekClaude 或 handleGLMClaude
/v1/models           → 合并所有渠道的模型列表
```

**优势**：
- ✅ 符合 OpenAI/Claude 标准
- ✅ 单一端点，统一配置
- ✅ SDK 开箱即用

---

## 核心设计决策

### 决策 1: 模型路由器设计

**职责**：根据模型名称前缀识别目标渠道。

**模块**：`src/model-router.js`

**接口**：

```javascript
/**
 * 路由模型到正确的渠道
 * @param {string} modelName - 模型名称
 * @returns {{channel: string, model: string}} 渠道和模型信息
 * @throws {Error} 未知模型时抛出错误
 */
export function routeModel(modelName) {
  // 输入验证
  if (!modelName || typeof modelName !== 'string') {
    throw new Error('模型名称是必需的');
  }
  
  // DeepSeek 模型
  if (modelName.startsWith('deepseek-')) {
    return { channel: 'deepseek', model: modelName };
  }
  
  // GLM 模型
  if (modelName.startsWith('glm-') || modelName.startsWith('cogview-')) {
    return { channel: 'glm', model: modelName };
  }
  
  // 未知模型
  throw new Error(`未知模型: ${modelName}。支持的模型: deepseek-*, glm-*, cogview-*`);
}
```

**路由规则**：

| 模型前缀 | 渠道 | 示例 |
|---------|------|------|
| `deepseek-` | `deepseek` | `deepseek-v4-flash` |
| `glm-` | `glm` | `glm-4`, `glm-4-plus` |
| `cogview-` | `glm` | `cogview-3` |
| 其他 | 错误 | 抛出异常 |

**为什么这样设计**：
- 简单的字符串前缀匹配，性能高（O(1)）
- 扩展性好：新渠道只需添加一个 if 分支
- 明确的错误处理，不使用默认降级

---

### 决策 2: 统一端点处理器

**目标**：重构 `src/index.js` 的路由定义，使用模型路由器分发请求。

#### OpenAI 格式端点（`/v1/chat/completions`）

```javascript
import { routeModel } from './model-router.js';

app.post('/v1/chat/completions', async (req, res) => {
  try {
    // 1. 路由模型
    const { channel } = routeModel(req.body.model);
    
    // 2. 分发到对应处理器
    if (channel === 'deepseek') {
      return await handleOpenAICompletion(req, res);
    } else if (channel === 'glm') {
      return await handleGLMOpenAI(req, res);
    }
    
  } catch (err) {
    // 3. 错误处理（OpenAI 格式）
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
```

#### Claude 格式端点（`/v1/messages`）

```javascript
app.post('/v1/messages', async (req, res) => {
  try {
    // 1. 路由模型
    const { channel } = routeModel(req.body.model);
    
    // 2. 分发到对应处理器
    if (channel === 'deepseek') {
      return await handleDeepSeekClaude(req, res);
    } else if (channel === 'glm') {
      return await handleGLMClaude(req, res);
    }
    
  } catch (err) {
    // 3. 错误处理（Claude 格式）
    return res.status(400).json({
      type: 'error',
      error: {
        type: 'invalid_request_error',
        message: err.message
      }
    });
  }
});
```

**关键点**：
- 路由逻辑在最外层，与处理器解耦
- 错误格式根据端点类型返回（OpenAI vs Claude）
- 处理器函数保持不变，无需修改

---

### 决策 3: 统一模型列表

**目标**：`GET /v1/models` 返回所有渠道的模型。

**实现方式**：

```javascript
import { MODEL_MAP as DEEPSEEK_MODELS } from './openai.js';
import { MODEL_MAP as GLM_MODELS } from './glm.js';

app.get('/v1/models', (req, res) => {
  // DeepSeek 模型
  const deepseekModels = Object.keys(DEEPSEEK_MODELS).map(id => ({
    id,
    object: 'model',
    created: 1700000000,
    owned_by: 'deepseek',
  }));
  
  // GLM 模型
  const glmModels = Object.keys(GLM_MODELS).map(id => ({
    id,
    object: 'model',
    created: 1700000000,
    owned_by: 'zhipu',
  }));
  
  // 合并（按渠道分组）
  res.json({
    object: 'list',
    data: [...deepseekModels, ...glmModels]
  });
});
```

**排序规则**：
- DeepSeek 模型在前（7 个）
- GLM 模型在后（6 个）
- 总计 13 个模型

---

## 数据流

### 请求流程

```
客户端请求
  ↓ POST /v1/chat/completions {model: "deepseek-v4-flash"}
统一端点
  ↓ routeModel("deepseek-v4-flash")
模型路由器
  ↓ {channel: "deepseek", model: "deepseek-v4-flash"}
分发逻辑
  ↓ if (channel === 'deepseek')
handleOpenAICompletion(req, res)
  ↓ 调用 DeepSeek API
响应
  ↓ OpenAI 格式 JSON
客户端
```

### 错误流程

```
客户端请求
  ↓ POST /v1/chat/completions {model: "gpt-4"}
统一端点
  ↓ routeModel("gpt-4")
模型路由器
  ↓ throw Error("未知模型: gpt-4...")
错误处理
  ↓ catch (err)
格式化错误
  ↓ OpenAI 错误格式
客户端
  ↓ 400 Bad Request
```

---

## 兼容性

### 向后兼容

**不需要**：项目未上线，直接移除旧端点。

**移除的端点**：
```javascript
// 移除 DeepSeek 渠道端点
- app.post('/deepseek/v1/chat/completions', handleOpenAICompletion);
- app.post('/deepseek/v1/messages', handleDeepSeekClaude);
- app.get('/deepseek/v1/models', handleDeepSeekModels);

// 移除 GLM 渠道端点
- app.post('/glm/v1/chat/completions', handleGLMOpenAI);
- app.post('/glm/v1/messages', handleGLMClaude);
- app.get('/glm/v1/models', handleGLMModels);
```

**保留的端点**：
```javascript
// 旧版端点（已废弃但保留）
app.post('/api/v0/chat/completion', handleDeepSeekCompletion);

// Admin 和健康检查端点
app.get('/', ...);
app.get('/admin', ...);
app.get('/performance', ...);
```

### SDK 兼容性

#### OpenAI SDK

```javascript
// 使用统一端点
import OpenAI from 'openai';

const client = new OpenAI({
  baseURL: 'http://localhost:3000/v1',  // 标准端点
  apiKey: 'sk-xxx'
});

// DeepSeek 模型
await client.chat.completions.create({
  model: 'deepseek-v4-flash',
  messages: [...]
});

// GLM 模型
await client.chat.completions.create({
  model: 'glm-4',
  messages: [...]
});
```

#### Claude SDK

```javascript
// 使用统一端点
import Anthropic from '@anthropic-ai/sdk';

const client = new Anthropic({
  baseURL: 'http://localhost:3000/v1',  // 标准端点
  apiKey: 'sk-xxx'
});

// DeepSeek 模型
await client.messages.create({
  model: 'deepseek-v4-flash',
  messages: [...]
});

// GLM 模型
await client.messages.create({
  model: 'glm-4',
  messages: [...]
});
```

---

## 错误处理

### 模型路由错误

| 场景 | 错误消息 | HTTP 状态码 |
|------|---------|-----------|
| 模型名称为空 | `模型名称是必需的` | 400 |
| 未知模型前缀 | `未知模型: xxx。支持的模型: deepseek-*, glm-*, cogview-*` | 400 |

### 错误响应格式

#### OpenAI 格式

```json
{
  "error": {
    "message": "未知模型: gpt-4。支持的模型: deepseek-*, glm-*, cogview-*",
    "type": "invalid_request_error",
    "param": "model",
    "code": "model_not_found"
  }
}
```

#### Claude 格式

```json
{
  "type": "error",
  "error": {
    "type": "invalid_request_error",
    "message": "未知模型: claude-3-opus。支持的模型: deepseek-*, glm-*, cogview-*"
  }
}
```

---

## 性能考虑

### 路由性能

- **字符串前缀匹配**：O(1) 复杂度，< 1ms
- **无额外网络调用**：路由在本地完成
- **无缓存需求**：路由逻辑足够简单快速

### 扩展性

**添加新渠道**：
1. 在 `model-router.js` 添加新的前缀规则
2. 在统一端点添加新的 if 分支
3. 在 `/v1/models` 添加新渠道的模型

**示例**（添加假设的 Gemini 渠道）：
```javascript
// model-router.js
if (modelName.startsWith('gemini-')) {
  return { channel: 'gemini', model: modelName };
}

// index.js - /v1/chat/completions
if (channel === 'gemini') {
  return await handleGeminiOpenAI(req, res);
}

// index.js - /v1/models
const geminiModels = [...];
data: [...deepseekModels, ...glmModels, ...geminiModels]
```

---

## 测试策略

### 单元测试（建议）

```javascript
// test/model-router.test.js
describe('模型路由器', () => {
  it('DeepSeek 模型路由到 deepseek', () => {
    const result = routeModel('deepseek-v4-flash');
    assert.equal(result.channel, 'deepseek');
  });
  
  it('GLM 模型路由到 glm', () => {
    const result = routeModel('glm-4');
    assert.equal(result.channel, 'glm');
  });
  
  it('未知模型抛出错误', () => {
    assert.throws(() => routeModel('gpt-4'), /未知模型/);
  });
});
```

### 集成测试（手动验证）

```bash
# OpenAI 格式 - DeepSeek
curl -X POST http://localhost:3000/v1/chat/completions \
  -H "Authorization: Bearer sk-xxx" \
  -d '{"model":"deepseek-v4-flash","messages":[...]}'

# OpenAI 格式 - GLM
curl -X POST http://localhost:3000/v1/chat/completions \
  -H "Authorization: Bearer sk-xxx" \
  -d '{"model":"glm-4","messages":[...]}'

# Claude 格式 - DeepSeek
curl -X POST http://localhost:3000/v1/messages \
  -H "Authorization: Bearer sk-xxx" \
  -H "anthropic-version: 2023-06-01" \
  -d '{"model":"deepseek-v4-flash","messages":[...]}'

# 模型列表
curl http://localhost:3000/v1/models

# 错误情况
curl -X POST http://localhost:3000/v1/chat/completions \
  -H "Authorization: Bearer sk-xxx" \
  -d '{"model":"gpt-4","messages":[...]}'
```

---

## 回滚计划

如果重构出现问题：

1. **Git revert**（如果是 git 仓库）
2. **手动恢复**：
   - 恢复 `src/index.js` 中的渠道端点
   - 删除 `src/model-router.js`
   - 恢复原有的 `/v1/models` 实现

---

## 相关文档

- PRD: `.trellis/tasks/06-23-api-unification/prd.md`
- 实施计划: `.trellis/tasks/06-23-api-unification/implement.md`
- 评估报告: `docs/API_UNIFICATION_ASSESSMENT.md`
