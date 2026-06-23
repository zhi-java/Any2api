# 技术设计：统一多渠道 API 格式

## 架构概览

```
┌─────────────────────────────────────────────────────────────┐
│                        客户端请求                              │
│  OpenAI SDK / Claude SDK / 自定义客户端                        │
└─────────────────┬───────────────────────────────────────────┘
                  │
                  ▼
┌─────────────────────────────────────────────────────────────┐
│                    src/index.js (路由层)                       │
│  - API Key 鉴权                                               │
│  - 请求日志                                                    │
│  - 路由分发：/{channel}/v1/{endpoint}                         │
└─────────────────┬───────────────────────────────────────────┘
                  │
         ┌────────┴────────┬────────────────┐
         ▼                 ▼                ▼
┌──────────────┐  ┌──────────────┐  ┌──────────────┐
│ OpenAI 格式   │  │ Claude 格式   │  │ 原生格式      │
│ (直通)        │  │ (适配器转换)  │  │ (保留兼容)    │
└──────┬───────┘  └──────┬───────┘  └──────┬───────┘
       │                 │                 │
       │     ┌───────────▼────────┐        │
       │     │ src/adapters/      │        │
       │     │   claude.js        │        │
       │     │ - convertRequest   │        │
       │     │ - convertResponse  │        │
       │     │ - streamConvert    │        │
       │     └───────────┬────────┘        │
       │                 │                 │
       └─────────────────┼─────────────────┘
                         ▼
         ┌───────────────────────────────┐
         │     渠道处理器（统一接口）      │
         ├───────────────────────────────┤
         │   DeepSeek    │      GLM      │
         └───────┬───────┴───────┬───────┘
                 ▼               ▼
         ┌──────────────┬──────────────┐
         │  DeepSeek    │   GLM API    │
         │   Web API    │              │
         └──────────────┴──────────────┘
```

**注意**：第一期仅实现 DeepSeek 和 GLM 两个渠道。

## 核心组件设计

### 1. Claude 格式适配器 (`src/adapters/claude.js`)

#### 职责
- 将 Claude API 请求格式转换为 OpenAI 格式
- 将 OpenAI 响应格式转换为 Claude 格式
- 处理流式和非流式两种模式

#### 核心函数

```javascript
/**
 * 将 Claude 请求转换为 OpenAI 格式
 * @param {Object} claudeReq - Claude API 请求体
 * @returns {Object} OpenAI 格式请求
 */
export function convertClaudeRequest(claudeReq) {
  const { messages, system, max_tokens, temperature, top_p, tools, stream } = claudeReq;
  
  // 转换消息格式
  const openaiMessages = convertClaudeMessages(messages, system);
  
  // 转换工具定义
  const openaiTools = convertClaudeTools(tools);
  
  return {
    messages: openaiMessages,
    max_tokens,
    temperature,
    top_p,
    tools: openaiTools,
    stream: stream ?? false,
  };
}

/**
 * 将 OpenAI 非流式响应转换为 Claude 格式
 * @param {Object} openaiResp - OpenAI 响应
 * @param {string} model - 模型名称
 * @returns {Object} Claude 格式响应
 */
export function convertOpenAIResponse(openaiResp, model) {
  const choice = openaiResp.choices[0];
  const message = choice.message;
  
  // 构建 content 数组
  const content = [];
  
  if (message.content) {
    content.push({ type: 'text', text: message.content });
  }
  
  if (message.tool_calls) {
    for (const tc of message.tool_calls) {
      content.push({
        type: 'tool_use',
        id: tc.id,
        name: tc.function.name,
        input: JSON.parse(tc.function.arguments),
      });
    }
  }
  
  return {
    id: openaiResp.id.replace('chatcmpl-', 'msg_'),
    type: 'message',
    role: 'assistant',
    content,
    model,
    stop_reason: mapFinishReason(choice.finish_reason),
    usage: {
      input_tokens: openaiResp.usage?.prompt_tokens || 0,
      output_tokens: openaiResp.usage?.completion_tokens || 0,
    },
  };
}

/**
 * 将 OpenAI 流式响应转换为 Claude SSE 事件流
 * @param {ReadableStream} openaiStream - OpenAI SSE 流
 * @param {string} model - 模型名称
 * @returns {AsyncGenerator} Claude SSE 事件生成器
 */
export async function* streamOpenAIToClaude(openaiStream, model) {
  // 发送 message_start 事件
  yield {
    type: 'message_start',
    message: {
      id: `msg_${Date.now()}`,
      type: 'message',
      role: 'assistant',
      content: [],
      model,
    },
  };
  
  let contentBlockIndex = 0;
  let currentBlockType = null;
  let toolCallBuffer = {};
  
  for await (const chunk of parseOpenAIStream(openaiStream)) {
    const delta = chunk.choices?.[0]?.delta;
    
    if (delta?.content) {
      if (currentBlockType !== 'text') {
        yield {
          type: 'content_block_start',
          index: contentBlockIndex,
          content_block: { type: 'text', text: '' },
        };
        currentBlockType = 'text';
      }
      
      yield {
        type: 'content_block_delta',
        index: contentBlockIndex,
        delta: { type: 'text_delta', text: delta.content },
      };
    }
    
    if (delta?.tool_calls) {
      for (const tc of delta.tool_calls) {
        const tcIndex = tc.index;
        
        if (!toolCallBuffer[tcIndex]) {
          toolCallBuffer[tcIndex] = {
            id: tc.id,
            name: tc.function?.name || '',
            arguments: '',
          };
          
          yield {
            type: 'content_block_start',
            index: contentBlockIndex + tcIndex + 1,
            content_block: {
              type: 'tool_use',
              id: tc.id,
              name: tc.function.name,
            },
          };
        }
        
        if (tc.function?.arguments) {
          toolCallBuffer[tcIndex].arguments += tc.function.arguments;
          
          yield {
            type: 'content_block_delta',
            index: contentBlockIndex + tcIndex + 1,
            delta: {
              type: 'input_json_delta',
              partial_json: tc.function.arguments,
            },
          };
        }
      }
    }
    
    if (chunk.choices?.[0]?.finish_reason) {
      yield {
        type: 'content_block_stop',
        index: contentBlockIndex,
      };
      
      yield {
        type: 'message_delta',
        delta: { stop_reason: mapFinishReason(chunk.choices[0].finish_reason) },
        usage: { output_tokens: 0 },
      };
      
      yield { type: 'message_stop' };
    }
  }
}
```

#### 消息格式转换规则

**Claude → OpenAI**

| Claude | OpenAI | 说明 |
|--------|--------|------|
| `messages[].role: user/assistant` | `messages[].role: user/assistant` | 直接映射 |
| `system` 参数 | 追加到 `messages[0]` 作为 system role | 或合并到 user 消息前 |
| `content[].type: text` | `content: "text"` | 提取文本 |
| `content[].type: image` | `content[].type: image_url` | 转换图片格式 |
| `content[].type: tool_result` | 新增 `role: tool` 消息 | 工具结果 |
| `content[].type: tool_use` | `tool_calls` | 工具调用 |

**OpenAI → Claude**

| OpenAI | Claude | 说明 |
|--------|--------|------|
| `message.content` | `content[].type: text` | 文本内容 |
| `message.tool_calls` | `content[].type: tool_use` | 工具调用 |
| `finish_reason: stop` | `stop_reason: end_turn` | 正常结束 |
| `finish_reason: tool_calls` | `stop_reason: tool_use` | 工具调用 |
| `finish_reason: length` | `stop_reason: max_tokens` | 长度限制 |

### 2. 渠道路由处理器

#### DeepSeek 渠道 (`src/openai.js` 扩展)

```javascript
/**
 * 通用的 DeepSeek 处理器（支持 OpenAI 格式）
 * 可被直接调用或通过适配器调用
 */
export async function handleDeepSeekOpenAI(req, res) {
  // 现有的 handleOpenAICompletion 逻辑
  // 已完整实现，无需修改
}

/**
 * DeepSeek + Claude 格式处理器
 */
export async function handleDeepSeekClaude(req, res) {
  const claudeReq = req.body;
  const openaiReq = convertClaudeRequest(claudeReq);
  
  // 创建虚拟请求对象
  const virtualReq = { ...req, body: openaiReq };
  
  if (openaiReq.stream) {
    // 流式响应：拦截响应流，转换为 Claude 格式
    const openaiStream = await getDeepSeekStream(virtualReq);
    await streamClaudeResponse(res, openaiStream, claudeReq.model);
  } else {
    // 非流式响应：获取完整响应后转换
    const openaiResp = await getDeepSeekResponse(virtualReq);
    const claudeResp = convertOpenAIResponse(openaiResp, claudeReq.model);
    res.json(claudeResp);
  }
}
```

#### GLM 渠道 (`src/glm.js` 扩展)

```javascript
/**
 * GLM + OpenAI 格式处理器（已实现）
 */
export async function handleGLMOpenAI(req, res) {
  // 现有的 handleGLMCompletion 逻辑
  // 已完整实现，无需修改
}

/**
 * GLM + Claude 格式处理器
 */
export async function handleGLMClaude(req, res) {
  const claudeReq = req.body;
  const openaiReq = convertClaudeRequest(claudeReq);
  
  // 复用 GLM 的 OpenAI 格式处理逻辑
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

#### Gemini 渠道重构 (`src/gemini.js` 重构)

**第一期不实现**：Gemini 渠道完全不在第一期范围内，`src/gemini.js` 保持不动。

### 3. 路由注册 (`src/index.js`)

**重要**：路由格式为 `/{channel}/v1/{endpoint}`，符合标准 baseURL 规范。

**第一期范围**：仅注册 DeepSeek 和 GLM 两个渠道的路由。

```javascript
import { handleDeepSeekOpenAI, handleDeepSeekClaude, handleDeepSeekModels } from './openai.js';
import { handleGLMOpenAI, handleGLMClaude, handleGLMModels } from './glm.js';

// ... 现有鉴权中间件 ...

// ============= DeepSeek 渠道 =============
// 格式：/deepseek/v1/{endpoint}
app.post('/deepseek/v1/chat/completions', handleDeepSeekOpenAI);
app.post('/deepseek/v1/messages', handleDeepSeekClaude);
app.get('/deepseek/v1/models', handleDeepSeekModels);

// ============= GLM 渠道 =============
// 格式：/glm/v1/{endpoint}
app.post('/glm/v1/chat/completions', handleGLMOpenAI);
app.post('/glm/v1/messages', handleGLMClaude);
app.get('/glm/v1/models', handleGLMModels);

// ============= 向后兼容端点（保留） =============
app.post('/v1/chat/completions', handleDeepSeekOpenAI); // 默认 DeepSeek
app.post('/api/v0/chat/completion', handleDeepSeekCompletion); // DeepSeek 原生
app.get('/v1/models', handleDeepSeekModels); // 默认 DeepSeek
```

**客户端配置示例**：
```javascript
// OpenAI SDK - GLM 渠道
const glmClient = new OpenAI({
  baseURL: 'http://localhost:3000/glm/v1',
  apiKey: process.env.API_KEY
});

// OpenAI SDK - DeepSeek 渠道
const deepseekClient = new OpenAI({
  baseURL: 'http://localhost:3000/deepseek/v1',
  apiKey: process.env.API_KEY
});

// Anthropic SDK - DeepSeek 渠道
const claudeClient = new Anthropic({
  baseURL: 'http://localhost:3000/deepseek/v1',
  apiKey: process.env.API_KEY
});
```

## 数据流设计

### 请求流程（以 GLM Claude 格式为例）

```
1. 客户端发送 Claude 格式请求
   POST /glm/v1/messages
   {
     "model": "glm-4-plus",
     "messages": [{"role": "user", "content": "Hello"}],
     "max_tokens": 1024
   }

2. index.js 路由层
   - API Key 鉴权 ✓
   - requestLogger 记录 ✓
   - 路由到 handleGLMClaude

3. handleGLMClaude (glm.js)
   - 调用 convertClaudeRequest 转换为 OpenAI 格式
   - 创建虚拟请求对象
   - 调用 GLM 核心处理逻辑

4. GLM 核心处理 (glm.js)
   - Token 管理（访客模式或 refresh token）
   - 消息格式转换（OpenAI → GLM 内部格式）
   - 调用 GLM API
   - 解析 SSE 流

5. 响应转换
   - parseGLMStream 解析 GLM 响应
   - streamOpenAIToClaude 转换为 Claude SSE 格式
   - 返回客户端

6. 客户端接收 Claude 格式 SSE 流
   event: message_start
   data: {"type":"message_start","message":{...}}
   
   event: content_block_delta
   data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"Hello"}}
   
   event: message_stop
   data: {"type":"message_stop"}
```

## 兼容性和迁移策略

### 向后兼容保证

| 现有端点 | 行为 | 保证 |
|---------|------|------|
| `POST /v1/chat/completions` | 继续作为 DeepSeek OpenAI 格式端点 | ✅ 完全兼容 |
| `POST /api/v0/chat/completion` | DeepSeek 原生格式 | ✅ 完全兼容 |
| `GET /v1/models` | 返回 DeepSeek 模型列表 | ✅ 完全兼容 |

### 新端点规范

所有新端点遵循统一规范：

```
OpenAI 格式：POST /v1/{channel}/chat/completions
Claude 格式：POST /v1/{channel}/messages
模型列表：  GET /v1/{channel}/models
```

其中 `{channel}` 为：`deepseek` | `glm` | `gemini`

## 工具调用支持

### OpenAI 格式工具调用

```javascript
// 请求
{
  "model": "glm-4-plus",
  "messages": [...],
  "tools": [{
    "type": "function",
    "function": {
      "name": "get_weather",
      "parameters": { "type": "object", "properties": {...} }
    }
  }]
}

// 响应
{
  "choices": [{
    "message": {
      "role": "assistant",
      "tool_calls": [{
        "id": "call_123",
        "type": "function",
        "function": {
          "name": "get_weather",
          "arguments": "{\"city\":\"Beijing\"}"
        }
      }]
    },
    "finish_reason": "tool_calls"
  }]
}
```

### Claude 格式工具调用

```javascript
// 请求
{
  "model": "glm-4-plus",
  "messages": [...],
  "tools": [{
    "name": "get_weather",
    "input_schema": { "type": "object", "properties": {...} }
  }]
}

// 响应
{
  "content": [{
    "type": "tool_use",
    "id": "toolu_123",
    "name": "get_weather",
    "input": { "city": "Beijing" }
  }],
  "stop_reason": "tool_use"
}
```

### 转换逻辑

**Claude tools → OpenAI tools**
```javascript
function convertClaudeTools(claudeTools) {
  return claudeTools.map(t => ({
    type: 'function',
    function: {
      name: t.name,
      description: t.description || '',
      parameters: t.input_schema,
    },
  }));
}
```

**OpenAI tool_calls → Claude tool_use**
```javascript
function convertToolCalls(toolCalls) {
  return toolCalls.map(tc => ({
    type: 'tool_use',
    id: tc.id.replace('call_', 'toolu_'),
    name: tc.function.name,
    input: JSON.parse(tc.function.arguments),
  }));
}
```

## 错误处理策略

### 统一错误格式

**OpenAI 格式错误**
```javascript
{
  "error": {
    "message": "Invalid API key",
    "type": "invalid_request_error",
    "code": "invalid_api_key"
  }
}
```

**Claude 格式错误**
```javascript
{
  "type": "error",
  "error": {
    "type": "invalid_request_error",
    "message": "Invalid API key"
  }
}
```

### 错误映射

| 场景 | OpenAI 错误 | Claude 错误 |
|------|------------|------------|
| 鉴权失败 | `invalid_request_error` | `authentication_error` |
| 模型不存在 | `invalid_request_error` | `invalid_request_error` |
| 参数错误 | `invalid_request_error` | `invalid_request_error` |
| 速率限制 | `rate_limit_error` | `rate_limit_error` |
| 服务器错误 | `api_error` | `api_error` |

## 性能考虑

### 适配器性能

- **转换开销**：Claude ↔ OpenAI 格式转换为纯内存操作，延迟 < 1ms
- **流式转换**：逐块转换，无需缓冲完整响应
- **内存占用**：流式模式下内存占用与单次请求相同

### 缓存策略

- Token 缓存：GLM token 继续使用现有缓存机制（1小时 TTL）
- 模型列表缓存：各渠道模型列表可静态缓存（启动时加载）

## 测试策略

### 单元测试

- `src/adapters/claude.js` 的转换函数
  - `convertClaudeRequest` 各种消息格式
  - `convertOpenAIResponse` 各种响应类型
  - `streamOpenAIToClaude` 流式转换逻辑

### 集成测试

- 各渠道 OpenAI 格式端点
- 各渠道 Claude 格式端点
- 工具调用端到端测试
- 流式和非流式响应测试

### 兼容性测试

- 现有端点向后兼容性验证
- OpenAI SDK 客户端测试
- Claude SDK 客户端测试（如果有）
