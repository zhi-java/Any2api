# API 端点统一重构 - 实施计划

## 实施顺序

按照依赖关系和风险，分 3 个阶段实施：

1. **Phase 1**: 创建模型路由器（独立模块，低风险）
2. **Phase 2**: 重构统一端点（核心功能，中风险）
3. **Phase 3**: 清理和文档（收尾工作，低风险）

---

## Phase 1: 创建模型路由器

### 1.1 创建 model-router.js

**文件**: `src/model-router.js` (新建)

**任务**:
- [ ] 创建文件并添加文档注释
- [ ] 实现 `routeModel(modelName)` 函数
  - 输入验证（空值、类型检查）
  - DeepSeek 模型识别（`deepseek-` 前缀）
  - GLM 模型识别（`glm-`, `cogview-` 前缀）
  - 未知模型错误处理（中文错误消息）
- [ ] 导出函数

**代码模板**:
```javascript
/**
 * 模型路由器
 * 
 * 根据模型名称前缀路由到正确的渠道处理器
 */

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

**验证命令**:
```bash
node --check src/model-router.js
```

**风险点**:
- 确保中文字符编码正确
- 错误消息清晰易懂

---

## Phase 2: 重构统一端点

### 2.1 更新 index.js - 导入模型路由器

**文件**: `src/index.js`

**任务**:
- [ ] 在文件顶部添加导入
  ```javascript
  import { routeModel } from './model-router.js';
  ```

**验证命令**:
```bash
node --check src/index.js
```

---

### 2.2 重构 /v1/chat/completions

**文件**: `src/index.js`

**任务**:
- [ ] 找到现有的 `/v1/chat/completions` 路由（约第 42 行）
- [ ] 替换为统一处理器

**原代码**:
```javascript
app.post('/v1/chat/completions', handleOpenAICompletion);
```

**新代码**:
```javascript
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

**验证命令**:
```bash
node --check src/index.js
```

**测试**:
```bash
# DeepSeek 模型
curl -X POST http://localhost:3000/v1/chat/completions \
  -H "Authorization: Bearer sk-xxx" \
  -H "Content-Type: application/json" \
  -d '{"model":"deepseek-v4-flash","messages":[{"role":"user","content":"Hi"}]}'

# GLM 模型
curl -X POST http://localhost:3000/v1/chat/completions \
  -H "Authorization: Bearer sk-xxx" \
  -H "Content-Type: application/json" \
  -d '{"model":"glm-4","messages":[{"role":"user","content":"你好"}]}'

# 未知模型（应返回 400）
curl -X POST http://localhost:3000/v1/chat/completions \
  -H "Authorization: Bearer sk-xxx" \
  -H "Content-Type: application/json" \
  -d '{"model":"gpt-4","messages":[{"role":"user","content":"Hi"}]}'
```

**风险点**:
- 确保 `handleGLMOpenAI` 正确导入
- 错误处理不应影响正常流程

---

### 2.3 重构 /v1/messages

**文件**: `src/index.js`

**任务**:
- [ ] 找到 `/v1/messages` 路由（如果不存在则新增）
- [ ] 实现统一处理器（Claude 格式）

**新代码**:
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

**验证命令**:
```bash
node --check src/index.js
```

**测试**:
```bash
# DeepSeek Claude 格式
curl -X POST http://localhost:3000/v1/messages \
  -H "Authorization: Bearer sk-xxx" \
  -H "Content-Type: application/json" \
  -H "anthropic-version: 2023-06-01" \
  -d '{"model":"deepseek-v4-flash","messages":[{"role":"user","content":"Hi"}],"max_tokens":100}'

# GLM Claude 格式
curl -X POST http://localhost:3000/v1/messages \
  -H "Authorization: Bearer sk-xxx" \
  -H "Content-Type: application/json" \
  -H "anthropic-version: 2023-06-01" \
  -d '{"model":"glm-4","messages":[{"role":"user","content":"你好"}],"max_tokens":100}'
```

**风险点**:
- 确保 Claude 格式错误响应正确
- 注意 `anthropic-version` 头的处理

---

### 2.4 重构 /v1/models

**文件**: `src/index.js`

**任务**:
- [ ] 找到现有的 `/v1/models` 路由（约第 43 行）
- [ ] 从 `openai.js` 和 `glm.js` 导出 `MODEL_MAP`
- [ ] 替换为动态生成所有渠道模型的实现

**步骤 1**: 导出 MODEL_MAP

在 `src/openai.js` 中添加导出（找到 MODEL_MAP 定义处）:
```javascript
const MODEL_MAP = {
  'deepseek-v4-flash': 'default',
  // ... 其他模型
};

// 添加导出
export { MODEL_MAP as DEEPSEEK_MODEL_MAP };
```

在 `src/glm.js` 中添加导出（找到 MODEL_MAP 定义处）:
```javascript
const MODEL_MAP = {
  'glm-4': { assistantId: DEFAULT_ASSISTANT_ID, ... },
  // ... 其他模型
};

// 添加导出
export { MODEL_MAP as GLM_MODEL_MAP };
```

**步骤 2**: 更新 index.js 导入

在 `src/index.js` 顶部添加:
```javascript
import { DEEPSEEK_MODEL_MAP } from './openai.js';
import { GLM_MODEL_MAP } from './glm.js';
```

**步骤 3**: 实现统一模型列表

**原代码**:
```javascript
app.get('/v1/models', handleOpenAIModels);
```

**新代码**:
```javascript
app.get('/v1/models', (req, res) => {
  // DeepSeek 模型（动态从 MODEL_MAP 生成）
  const deepseekModels = Object.keys(DEEPSEEK_MODEL_MAP).map(id => ({
    id,
    object: 'model',
    created: 1700000000,
    owned_by: 'deepseek',
  }));
  
  // GLM 模型（动态从 MODEL_MAP 生成）
  const glmModels = Object.keys(GLM_MODEL_MAP).map(id => ({
    id,
    object: 'model',
    created: 1700000000,
    owned_by: 'zhipu',
  }));
  
  // 合并（按渠道分组：DeepSeek 在前，GLM 在后）
  res.json({
    object: 'list',
    data: [...deepseekModels, ...glmModels]
  });
});
```

**验证命令**:
```bash
node --check src/openai.js
node --check src/glm.js
node --check src/index.js
```

**测试**:
```bash
curl http://localhost:3000/v1/models | jq '.data | length'
# 应返回 13

curl http://localhost:3000/v1/models | jq '.data[0]'
# 应返回第一个 DeepSeek 模型

curl http://localhost:3000/v1/models | jq '.data[7]'
# 应返回第一个 GLM 模型

curl http://localhost:3000/v1/models | jq '.data[-1]'
# 应返回最后一个 GLM 模型（cogview-3）
```

**风险点**:
- ✅ 动态生成，与 MODEL_MAP 同步，无需手动维护
- ⚠️ 需要正确导出 MODEL_MAP
- ⚠️ 确保 `owned_by` 字段正确（DeepSeek → 'deepseek', GLM → 'zhipu'）

---

### 2.5 移除渠道特定端点

**文件**: `src/index.js`

**任务**:
- [ ] 删除 `/deepseek/v1/*` 端点（约第 48-51 行）
- [ ] 删除 `/glm/v1/*` 端点（约第 53-56 行）
- [ ] 保留 `/api/v0/chat/completion` 旧版端点

**删除的代码**:
```javascript
// ============= DeepSeek 渠道 (/{channel}/v1/{endpoint}) =============
app.post('/deepseek/v1/chat/completions', handleOpenAICompletion);
app.post('/deepseek/v1/messages', handleDeepSeekClaude);
app.get('/deepseek/v1/models', handleDeepSeekModels);

// ============= GLM 渠道 (/{channel}/v1/{endpoint}) =============
app.post('/glm/v1/chat/completions', handleGLMOpenAI);
app.post('/glm/v1/messages', handleGLMClaude);
app.get('/glm/v1/models', handleGLMModels);
```

**验证命令**:
```bash
# 确保旧端点返回 404
curl -I http://localhost:3000/deepseek/v1/models
# 应返回 404

curl -I http://localhost:3000/glm/v1/models
# 应返回 404
```

**风险点**:
- 确保没有删除其他重要端点
- 保留 Admin 和健康检查端点

---

### 2.6 清理未使用的导入

**文件**: `src/index.js`

**任务**:
- [ ] 检查 `handleDeepSeekModels` 和 `handleGLMModels` 是否还被使用
- [ ] 如果未使用，从导入语句中移除

**原导入**:
```javascript
import { handleOpenAICompletion, handleOpenAIModels, handleDeepSeekClaude, handleDeepSeekModels } from './openai.js';
import { handleGLMOpenAI, handleGLMClaude, handleGLMModels } from './glm.js';
```

**新导入**（如果模型列表函数未使用）:
```javascript
import { handleOpenAICompletion, handleDeepSeekClaude } from './openai.js';
import { handleGLMOpenAI, handleGLMClaude } from './glm.js';
```

**验证命令**:
```bash
node --check src/index.js
```

---

## Phase 3: 清理和文档

### 3.1 更新 README

**文件**: `README.md`

**任务**:
- [ ] 更新 API 端点文档
- [ ] 更新配置示例
- [ ] 添加模型列表

**更新内容**:

```markdown
## API 端点

### OpenAI 格式
- `POST /v1/chat/completions` - 聊天补全（支持所有渠道）
- `GET /v1/models` - 模型列表

### Claude 格式
- `POST /v1/messages` - 聊天消息（支持所有渠道）

## 支持的模型

### DeepSeek 渠道
- `deepseek-v4-flash`
- `deepseek-v4-pro`
- `deepseek-v4-vision`
- `deepseek-v4-pro-search`
- `deepseek-v4-flash[1m]`
- `deepseek-v4-pro[1m]`
- `deepseek-v4-vision[1m]`

### GLM 渠道
- `glm-4`
- `glm-4-plus`
- `glm-4-search`
- `glm-4v`
- `glm-4-flash`
- `cogview-3`

## 使用示例

### OpenAI SDK

\`\`\`javascript
import OpenAI from 'openai';

const client = new OpenAI({
  baseURL: 'http://localhost:3000/v1',
  apiKey: 'sk-xxx'
});

// 使用 DeepSeek
await client.chat.completions.create({
  model: 'deepseek-v4-flash',
  messages: [{ role: 'user', content: 'Hello' }]
});

// 使用 GLM
await client.chat.completions.create({
  model: 'glm-4',
  messages: [{ role: 'user', content: '你好' }]
});
\`\`\`

### Claude SDK

\`\`\`javascript
import Anthropic from '@anthropic-ai/sdk';

const client = new Anthropic({
  baseURL: 'http://localhost:3000/v1',
  apiKey: 'sk-xxx'
});

// 使用 DeepSeek
await client.messages.create({
  model: 'deepseek-v4-flash',
  messages: [{ role: 'user', content: 'Hello' }],
  max_tokens: 1024
});

// 使用 GLM
await client.messages.create({
  model: 'glm-4',
  messages: [{ role: 'user', content: '你好' }],
  max_tokens: 1024
});
\`\`\`
```

---

### 3.2 更新变更日志

**文件**: `docs/CHANGELOG.md`

**任务**:
- [ ] 添加本次重构的变更记录

**新增内容**:
```markdown
## [未发布] - 2026-06-23

### 重大变更
- **API 端点统一**：移除渠道特定端点，统一为标准 OpenAI/Claude 端点
  - 移除 `/deepseek/v1/*` 端点
  - 移除 `/glm/v1/*` 端点
  - 统一为 `/v1/chat/completions`, `/v1/messages`, `/v1/models`
  - 通过 `model` 参数自动路由到正确渠道

### 新增
- **模型路由器**：新增 `src/model-router.js` 模块，根据模型名称前缀自动路由
- **统一模型列表**：`/v1/models` 返回所有渠道的模型（13 个）

### 改进
- **完全兼容 OpenAI/Claude SDK**：只需配置 `baseURL: '.../v1'` 即可使用
- **中文错误提示**：未知模型返回清晰的中文错误消息

### 破坏性变更
- ⚠️ 旧的渠道端点已移除（项目未上线，无影响）
```

---

### 3.3 语法检查

**任务**:
- [ ] 检查所有修改文件的语法

**验证命令**:
```bash
node --check src/model-router.js
node --check src/index.js
echo "All syntax checks passed!"
```

---

### 3.4 功能测试清单

**任务**:
- [ ] 启动服务：`npm start`
- [ ] 测试 DeepSeek OpenAI 格式
- [ ] 测试 GLM OpenAI 格式
- [ ] 测试 DeepSeek Claude 格式
- [ ] 测试 GLM Claude 格式
- [ ] 测试统一模型列表
- [ ] 测试未知模型错误
- [ ] 测试旧端点已移除（返回 404）

**测试脚本**（可选创建 `test/api-unification.sh`）:
```bash
#!/bin/bash

BASE_URL="http://localhost:3000"
API_KEY="sk-xxx"

echo "=== Testing Unified API Endpoints ==="

# Test 1: DeepSeek OpenAI format
echo "1. DeepSeek OpenAI format..."
curl -s -X POST $BASE_URL/v1/chat/completions \
  -H "Authorization: Bearer $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"model":"deepseek-v4-flash","messages":[{"role":"user","content":"Hi"}],"max_tokens":10}' \
  | jq '.choices[0].message.content'

# Test 2: GLM OpenAI format
echo "2. GLM OpenAI format..."
curl -s -X POST $BASE_URL/v1/chat/completions \
  -H "Authorization: Bearer $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"model":"glm-4","messages":[{"role":"user","content":"你好"}],"max_tokens":10}' \
  | jq '.choices[0].message.content'

# Test 3: Unified models list
echo "3. Unified models list..."
curl -s $BASE_URL/v1/models | jq '.data | length'

# Test 4: Unknown model error
echo "4. Unknown model error..."
curl -s -X POST $BASE_URL/v1/chat/completions \
  -H "Authorization: Bearer $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"model":"gpt-4","messages":[{"role":"user","content":"Hi"}]}' \
  | jq '.error.message'

# Test 5: Old endpoints removed
echo "5. Old endpoints removed..."
curl -I -s $BASE_URL/deepseek/v1/models | head -n 1

echo "=== Tests Complete ==="
```

---

## 完成检查清单

在调用 `task.py start` 之前确认：

- [ ] PRD、design.md、implement.md 都已完成
- [ ] 理解了重构的影响范围
- [ ] 准备好测试环境（API tokens）

在完成实施后确认：

- [ ] 所有 Phase 的任务都已完成
- [ ] 所有验证命令都已运行
- [ ] 功能测试通过
- [ ] 文档已更新
- [ ] 语法检查通过
- [ ] 旧端点已移除

---

## 预计时间

- Phase 1 (模型路由器): 20-30 分钟
- Phase 2 (统一端点): 60-90 分钟
- Phase 3 (清理和文档): 30-45 分钟

**总计**: 2-2.5 小时
