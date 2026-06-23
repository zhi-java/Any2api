# GLM 渠道增强优化 - 技术设计

## 架构概览

### 当前架构（非流式）

```
客户端
  ↓ Claude 格式请求
handleDeepSeekClaude / handleGLMClaude
  ↓ 1. 转换请求格式 (Claude → OpenAI)
  ↓ 2. 临时替换 req.body
  ↓ 3. Mock res 拦截响应
handleOpenAICompletion / handleGLMCompletion
  ↓ 调用底层 API
Mock res.json(data)
  ↓ 4. 捕获响应
  ↓ 5. 转换格式 (OpenAI → Claude)
客户端 ← Claude 格式响应
```

**问题**：响应拦截模式无法支持流式响应（流无法完整捕获）。

### 目标架构（统一流式和非流式）

```
客户端
  ↓ Claude 格式请求 (stream: true/false)
handleDeepSeekClaude / handleGLMClaude (重构)
  ↓ 1. 转换请求格式 (Claude → OpenAI)
  ↓ 2. 调用统一 API 层
  ↓
callDeepSeekAPI / callGLMAPI (新增)
  ↓ 根据 stream 参数决定调用方式
  ↓ 返回: Promise<Response> (流式) 或 Promise<Object> (非流式)
  ↓
handleDeepSeekClaude / handleGLMClaude
  ↓ 3. 判断响应类型
  ├─ 流式: streamOpenAIToClaude → writeClaudeSSE
  └─ 非流式: convertOpenAIResponse → res.json
  ↓
客户端 ← Claude 格式响应
```

**优势**：
- ✅ 流式和非流式使用统一路径
- ✅ 不依赖响应拦截
- ✅ 清晰的职责分离

---

## 核心设计决策

### 决策 1: 统一 API 调用层

**新增模块**：`src/api-client.js`

**职责**：
- 封装对 DeepSeek 和 GLM 底层 API 的直接调用
- 处理 Token 管理和认证
- 返回统一的响应格式（流或对象）

**接口设计**：

```javascript
// DeepSeek API 客户端
export async function callDeepSeekAPI(openaiReq, options = {}) {
  const { stream = false, token } = options;
  
  // 构建请求
  const url = 'https://api.deepseek.com/v1/chat/completions';
  const body = { ...openaiReq, stream };
  
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  
  if (!response.ok) {
    throw new Error(`DeepSeek API error: ${response.status}`);
  }
  
  if (stream) {
    return response.body; // ReadableStream
  } else {
    return await response.json(); // Object
  }
}

// GLM API 客户端
export async function callGLMAPI(openaiReq, options = {}) {
  const { stream = false, tokenManager } = options;
  
  // 从 token 池获取 access token
  const accessToken = await tokenManager.getAccessToken();
  
  // 构建 GLM 格式请求
  const glmReq = convertOpenAIToGLM(openaiReq);
  
  const response = await fetch('https://chatglm.cn/chatglm/backend-api/assistant/stream', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
      ...generateGLMHeaders(),
    },
    body: JSON.stringify(glmReq),
  });
  
  if (!response.ok) {
    throw new Error(`GLM API error: ${response.status}`);
  }
  
  if (stream) {
    return response.body; // ReadableStream
  } else {
    // 对于非流式，需要手动解析 SSE 流
    return await parseGLMNonStreamResponse(response.body);
  }
}
```

**要点**：
- 统一的错误处理
- 流式返回 `ReadableStream`，非流式返回 `Object`
- Token 管理封装在调用层

---

### 决策 2: Token 池管理

**扩展 `GlmTokenManager` 类**：

```javascript
class GlmTokenManager {
  constructor() {
    // 从环境变量加载 token 池
    this.tokens = this._loadTokens();
    this.currentIndex = 0;
    this.accessTokenCache = new Map(); // key: refreshToken, value: {accessToken, expiresAt}
  }
  
  _loadTokens() {
    // 优先级 1: GLM_REFRESH_TOKENS (多个)
    if (process.env.GLM_REFRESH_TOKENS) {
      return process.env.GLM_REFRESH_TOKENS
        .split(',')
        .map(t => t.trim())
        .filter(Boolean);
    }
    
    // 优先级 2: GLM_REFRESH_TOKEN (单个)
    if (process.env.GLM_REFRESH_TOKEN) {
      return [process.env.GLM_REFRESH_TOKEN];
    }
    
    // 优先级 3: 空数组（访客模式）
    return [];
  }
  
  async getAccessToken() {
    // 如果有 token 池，轮询选择
    if (this.tokens.length > 0) {
      const refreshToken = this._selectToken();
      return await this._getAccessTokenForRefresh(refreshToken);
    }
    
    // 降级到访客模式
    return await this._guestAccess();
  }
  
  _selectToken() {
    // Round-robin 轮询
    const token = this.tokens[this.currentIndex];
    this.currentIndex = (this.currentIndex + 1) % this.tokens.length;
    return token;
  }
  
  async _getAccessTokenForRefresh(refreshToken) {
    // 检查缓存
    const cached = this.accessTokenCache.get(refreshToken);
    if (cached && Date.now() < cached.expiresAt - 60000) {
      return cached.accessToken;
    }
    
    // 刷新 token
    try {
      const result = await this._refresh(refreshToken);
      this.accessTokenCache.set(refreshToken, {
        accessToken: result.access_token,
        expiresAt: Date.now() + 3600 * 1000,
      });
      return result.access_token;
    } catch (err) {
      console.warn(`[GLM] Refresh token failed:`, err.message);
      // 降级到访客模式
      return await this._guestAccess();
    }
  }
  
  // ... 其他现有方法
}
```

**配置示例**：

```bash
# 单个 token
GLM_REFRESH_TOKEN=eyJhbGciOi...

# 多个 tokens（推荐）
GLM_REFRESH_TOKENS=token1,token2,token3

# 无配置（访客模式）
# (不设置任何环境变量)
```

---

### 决策 3: 重构 Claude 处理器

**新的 `handleDeepSeekClaude` 实现**：

```javascript
export async function handleDeepSeekClaude(req, res) {
  try {
    const claudeReq = req.body;
    
    // 1. 转换请求格式
    const openaiReq = convertClaudeRequest(claudeReq);
    
    // 2. 调用统一 API 层
    const result = await callDeepSeekAPI(openaiReq, {
      stream: claudeReq.stream || false,
      token: getDeepSeekToken(), // 从配置获取
    });
    
    // 3. 根据类型处理响应
    if (claudeReq.stream) {
      // 流式响应
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
      });
      
      // 转换流并写入响应
      for await (const event of streamOpenAIToClaude(result, claudeReq.model)) {
        writeClaudeSSE(res, event);
      }
      
      res.end();
    } else {
      // 非流式响应
      const claudeResp = convertOpenAIResponse(result, claudeReq.model);
      res.json(claudeResp);
    }
    
  } catch (err) {
    console.error('[DeepSeek Claude] Error:', err.message);
    if (!res.headersSent) {
      res.status(500).json({
        type: 'error',
        error: {
          type: 'api_error',
          message: err.message,
        },
      });
    }
  }
}
```

**`handleGLMClaude` 类似实现，但使用 `callGLMAPI`**。

---

## 数据流

### 流式响应数据流

```
Client Request (stream: true)
  ↓
handleDeepSeekClaude
  ↓ convertClaudeRequest
OpenAI Request Format
  ↓ callDeepSeekAPI
ReadableStream (OpenAI SSE)
  ↓ streamOpenAIToClaude (async generator)
Claude Event Stream
  ↓ writeClaudeSSE (逐个事件)
Client ← SSE Events
```

### 非流式响应数据流

```
Client Request (stream: false)
  ↓
handleDeepSeekClaude
  ↓ convertClaudeRequest
OpenAI Request Format
  ↓ callDeepSeekAPI
OpenAI Response Object
  ↓ convertOpenAIResponse
Claude Response Object
  ↓ res.json
Client ← JSON Response
```

---

## 兼容性考虑

### 向后兼容

- ✅ 现有非流式功能保持不变
- ✅ 单 token 模式 (`GLM_REFRESH_TOKEN`) 继续支持
- ✅ 访客模式降级保持不变
- ✅ API 端点路径不变

### 破坏性变更

- ⚠️ 内部架构重构（但外部 API 不变）
- ⚠️ 移除响应拦截模式（内部实现细节）

---

## 错误处理

### 流式错误处理

```javascript
try {
  for await (const event of streamOpenAIToClaude(stream, model)) {
    if (res.writableEnded) break; // 客户端断开
    writeClaudeSSE(res, event);
  }
  res.end();
} catch (err) {
  if (!res.headersSent) {
    res.status(500).json({ type: 'error', error: { message: err.message } });
  } else {
    // 流已开始，发送错误事件
    writeClaudeSSE(res, {
      type: 'error',
      error: { type: 'api_error', message: err.message },
    });
    res.end();
  }
}
```

### Token 池错误处理

- 单个 token 刷新失败 → 降级到访客模式
- 所有 tokens 失败 → 返回 503 错误
- 访客模式失败 → 返回 503 错误

---

## 性能考虑

### Token 缓存

- ✅ 每个 refresh token 的 access token 独立缓存
- ✅ 59 分钟有效期（留 1 分钟 buffer）
- ✅ 自动刷新，无需手动管理

### 流式性能

- ✅ 使用 async generator，逐块处理
- ✅ 避免完整响应缓冲
- ✅ TCP_NODELAY 已在底层处理器启用

---

## 测试策略

### 单元测试（暂不实施）

- Token 池轮询逻辑
- 请求/响应格式转换
- 流式事件生成

### 集成测试（手动验证）

- 流式响应端到端测试
- Token 池轮询测试
- 工具调用功能测试
- 文件上传功能测试

---

## 回滚计划

如果新架构出现问题：

1. **Git revert**（如果是 git 仓库）
2. **或者手动恢复**：
   - 恢复 `handleDeepSeekClaude` 和 `handleGLMClaude` 到旧版本
   - 移除 `src/api-client.js`
   - 移除 Token 池相关代码

---

## 相关文档

- PRD: `.trellis/tasks/06-23-glm-enhancements/prd.md`
- 架构规范: `.trellis/spec/backend/api-integration.md`
- 实现计划: `.trellis/tasks/06-23-glm-enhancements/implement.md`
