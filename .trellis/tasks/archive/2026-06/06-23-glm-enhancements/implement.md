# GLM 渠道增强优化 - 实现计划

## 实施顺序

按照风险和依赖关系，分 3 个阶段实施：

1. **Phase 1**: Token 池管理（低风险，独立）
2. **Phase 2**: 统一 API 调用层（中风险，为流式响应做准备）
3. **Phase 3**: 流式响应支持（高风险，依赖 Phase 2）
4. **Phase 4**: 功能验证（低风险，验证整体）

---

## Phase 1: Token 池管理

### 1.1 扩展 GlmTokenManager 类

**文件**: `src/glm.js`

**任务**:
- [ ] 修改 `GlmTokenManager` 构造函数，支持 token 数组
- [ ] 实现 `_loadTokens()` 方法（读取环境变量）
- [ ] 实现 `_selectToken()` 方法（round-robin 轮询）
- [ ] 修改 `getAccessToken()` 支持 token 池
- [ ] 为每个 refresh token 独立缓存 access token

**验证命令**:
```bash
# 测试单 token 模式
GLM_REFRESH_TOKEN=test_token node -e "import('./src/glm.js').then(m => console.log('OK'))"

# 测试多 token 模式
GLM_REFRESH_TOKENS=token1,token2,token3 node -e "import('./src/glm.js').then(m => console.log('OK'))"

# 测试访客模式
node -e "import('./src/glm.js').then(m => console.log('OK'))"
```

**风险点**:
- 环境变量解析错误 → 添加输入验证
- Token 数组为空 → 确保降级到访客模式

---

### 1.2 更新文档

**文件**: `docs/GLM_TOKEN_SETUP.md`, `docs/GLM_INTEGRATION.md`

**任务**:
- [ ] 添加 `GLM_REFRESH_TOKENS` 配置说明
- [ ] 添加从浏览器 Cookies 获取 token 的教程
- [ ] 更新配置优先级说明

**验证**:
- 文档清晰易懂
- 示例配置正确

---

## Phase 2: 统一 API 调用层

### 2.1 创建 API 客户端模块

**文件**: `src/api-client.js` (新建)

**任务**:
- [ ] 实现 `callDeepSeekAPI(openaiReq, options)` 函数
  - 支持 `stream` 参数
  - 返回 `ReadableStream` 或 `Object`
  - 错误处理
- [ ] 实现 `callGLMAPI(openaiReq, options)` 函数
  - 集成 `GlmTokenManager`
  - 支持 `stream` 参数
  - GLM 格式转换
- [ ] 导出函数

**代码结构**:
```javascript
// src/api-client.js
export async function callDeepSeekAPI(openaiReq, options = {}) {
  // ... 实现
}

export async function callGLMAPI(openaiReq, options = {}) {
  // ... 实现
}
```

**验证命令**:
```bash
node --check src/api-client.js
```

**风险点**:
- GLM 非流式响应解析 → 需要手动解析 SSE 流
- Token 管理集成 → 确保 tokenManager 正确传递

---

### 2.2 辅助函数

**文件**: `src/glm.js`

**任务**:
- [ ] 实现 `parseGLMNonStreamResponse(stream)` - 解析 GLM SSE 流为对象
- [ ] 实现 `convertOpenAIToGLM(openaiReq)` - 格式转换（可能已存在）

**验证**:
- 函数正确解析 GLM SSE 流
- 格式转换正确

---

## Phase 3: 流式响应支持

### 3.1 重构 handleDeepSeekClaude

**文件**: `src/openai.js`

**任务**:
- [ ] 导入 `callDeepSeekAPI` 和适配器函数
- [ ] 重构 `handleDeepSeekClaude` 函数：
  - [ ] 移除响应拦截逻辑
  - [ ] 调用 `callDeepSeekAPI`
  - [ ] 判断流式/非流式
  - [ ] 流式：使用 `streamOpenAIToClaude` + `writeClaudeSSE`
  - [ ] 非流式：使用 `convertOpenAIResponse`
- [ ] 保留错误处理

**代码模板**:
```javascript
export async function handleDeepSeekClaude(req, res) {
  try {
    const claudeReq = req.body;
    const openaiReq = convertClaudeRequest(claudeReq);
    
    const result = await callDeepSeekAPI(openaiReq, {
      stream: claudeReq.stream || false,
      token: process.env.DEEPSEEK_API_KEY,
    });
    
    if (claudeReq.stream) {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
      });
      
      for await (const event of streamOpenAIToClaude(result, claudeReq.model)) {
        writeClaudeSSE(res, event);
      }
      res.end();
    } else {
      const claudeResp = convertOpenAIResponse(result, claudeReq.model);
      res.json(claudeResp);
    }
  } catch (err) {
    // 错误处理
  }
}
```

**验证命令**:
```bash
node --check src/openai.js
```

**测试**:
```bash
# 非流式（回归测试）
curl -X POST http://localhost:3000/deepseek/v1/messages \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer sk-test" \
  -d '{"model":"deepseek-v4-flash","messages":[{"role":"user","content":"Hi"}],"stream":false}'

# 流式（新功能）
curl -X POST http://localhost:3000/deepseek/v1/messages \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer sk-test" \
  -d '{"model":"deepseek-v4-flash","messages":[{"role":"user","content":"Hi"}],"stream":true}'
```

**风险点**:
- 破坏现有非流式功能 → 充分测试回归
- 流式事件顺序错误 → 验证 SSE 事件序列

---

### 3.2 重构 handleGLMClaude

**文件**: `src/glm.js`

**任务**:
- [ ] 导入 `callGLMAPI` 和适配器函数
- [ ] 重构 `handleGLMClaude` 函数（类似 handleDeepSeekClaude）
- [ ] 传递 `tokenManager` 实例

**代码要点**:
```javascript
const glmTokenManager = new GlmTokenManager();

export async function handleGLMClaude(req, res) {
  const result = await callGLMAPI(openaiReq, {
    stream: claudeReq.stream || false,
    tokenManager: glmTokenManager,
  });
  // ... 类似处理
}
```

**验证命令**:
```bash
node --check src/glm.js
```

**测试**:
```bash
# GLM 流式测试
curl -X POST http://localhost:3000/glm/v1/messages \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer sk-test" \
  -d '{"model":"glm-4","messages":[{"role":"user","content":"你好"}],"stream":true}'
```

---

### 3.3 更新适配器导入

**文件**: `src/openai.js`, `src/glm.js`

**任务**:
- [ ] 确保导入 `streamOpenAIToClaude` 和 `writeClaudeSSE`
- [ ] 移除未使用的导入

**验证**:
```bash
grep "import.*streamOpenAIToClaude" src/openai.js src/glm.js
```

---

## Phase 4: 功能验证

### 4.1 工具调用测试

**任务**:
- [ ] 创建测试脚本 `test/tool-calling-test.js`
- [ ] 定义简单工具（如 `get_weather`）
- [ ] 发送带工具定义的请求
- [ ] 验证 GLM 返回工具调用
- [ ] 记录结果

**测试脚本模板**:
```javascript
// test/tool-calling-test.js
const tools = [
  {
    name: 'get_weather',
    description: 'Get weather for a location',
    input_schema: {
      type: 'object',
      properties: {
        location: { type: 'string' }
      },
      required: ['location']
    }
  }
];

const response = await fetch('http://localhost:3000/glm/v1/messages', {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'Authorization': 'Bearer sk-test',
  },
  body: JSON.stringify({
    model: 'glm-4',
    messages: [{ role: 'user', content: 'What is the weather in Beijing?' }],
    tools,
    stream: false,
  }),
});

const result = await response.json();
console.log(JSON.stringify(result, null, 2));
```

**验证点**:
- [ ] 响应包含 `tool_use` content block
- [ ] 工具名称和参数正确

---

### 4.2 文件上传测试

**任务**:
- [ ] 创建测试脚本 `test/file-upload-test.js`
- [ ] 使用 base64 编码的图片
- [ ] 发送带图片的请求
- [ ] 验证 GLM 能识别图片内容
- [ ] 记录结果

**测试脚本模板**:
```javascript
const response = await fetch('http://localhost:3000/glm/v1/messages', {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'Authorization': 'Bearer sk-test',
  },
  body: JSON.stringify({
    model: 'glm-4v',
    messages: [{
      role: 'user',
      content: [
        { type: 'text', text: 'What is in this image?' },
        {
          type: 'image',
          source: {
            type: 'base64',
            media_type: 'image/png',
            data: '<base64_encoded_image>',
          },
        },
      ],
    }],
    stream: false,
  }),
});
```

**验证点**:
- [ ] 图片成功上传
- [ ] GLM 能描述图片内容

---

### 4.3 记录测试结果

**文件**: `docs/TESTING_RESULTS.md` (新建)

**任务**:
- [ ] 记录所有测试结果
- [ ] 标注已知限制
- [ ] 更新相关文档

**模板**:
```markdown
# 功能测试结果

## 测试环境
- 日期: YYYY-MM-DD
- GLM Token: 有效/访客模式

## 工具调用
- 状态: ✅ 通过 / ⚠️ 部分通过 / ❌ 失败
- 测试用例: ...
- 结果: ...
- 已知限制: ...

## 文件上传
- 状态: ...
- 结果: ...
```

---

## 质量检查

### 代码质量

**任务**:
- [ ] 运行语法检查
```bash
node --check src/api-client.js
node --check src/openai.js
node --check src/glm.js
node --check src/adapters/claude.js
```

- [ ] 检查导入/导出一致性
- [ ] 移除未使用的代码
- [ ] 统一错误处理格式

---

### 回归测试

**任务**:
- [ ] 测试原有非流式功能
```bash
# DeepSeek 非流式
curl -X POST http://localhost:3000/deepseek/v1/messages \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer sk-test" \
  -d '{"model":"deepseek-v4-flash","messages":[{"role":"user","content":"1+1=?"}],"stream":false}'

# GLM 非流式
curl -X POST http://localhost:3000/glm/v1/messages \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer sk-test" \
  -d '{"model":"glm-4","messages":[{"role":"user","content":"1+1=?"}],"stream":false}'
```

- [ ] 验证模型列表端点
```bash
curl http://localhost:3000/deepseek/v1/models
curl http://localhost:3000/glm/v1/models
```

---

## 文档更新

**任务**:
- [ ] 更新 `docs/GLM_INTEGRATION.md` - 添加流式响应说明
- [ ] 更新 `docs/GLM_TOKEN_SETUP.md` - Token 池配置
- [ ] 创建 `docs/TESTING_RESULTS.md` - 功能测试结果
- [ ] 更新 `docs/CHANGELOG.md` - 记录本次变更

---

## 完成检查清单

在调用 `task.py start` 之前确认：

- [ ] PRD、design.md、implement.md 都已完成
- [ ] 理解了架构重构的影响范围
- [ ] 准备好测试环境（有效的 Token 或访客模式）
- [ ] 了解回滚方案

在完成实施后确认：

- [ ] 所有 Phase 的任务都已完成
- [ ] 所有验证命令都已运行
- [ ] 回归测试通过
- [ ] 文档已更新
- [ ] 代码质量检查通过

---

## 预计时间

- Phase 1 (Token 池): 30-45 分钟
- Phase 2 (API 客户端): 45-60 分钟
- Phase 3 (流式响应): 60-90 分钟
- Phase 4 (功能验证): 30-45 分钟
- 质量检查 + 文档: 30 分钟

**总计**: 3.5-4.5 小时
