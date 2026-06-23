# GLM 渠道集成文档

## 概述

本项目已成功集成 GLM（智谱清言）反代渠道，支持 OpenAI 和 Claude 格式的 API 调用。

## 新增端点

### GLM 渠道

#### 1. OpenAI 格式
```
POST /glm/v1/chat/completions
```

**请求示例：**
```bash
curl -X POST http://localhost:3000/glm/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer YOUR_API_KEY" \
  -d '{
    "model": "glm-4",
    "messages": [{"role": "user", "content": "你好"}],
    "stream": false
  }'
```

#### 2. Claude 格式
```
POST /glm/v1/messages
```

**请求示例：**
```bash
curl -X POST http://localhost:3000/glm/v1/messages \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer YOUR_API_KEY" \
  -H "anthropic-version: 2023-06-01" \
  -d '{
    "model": "glm-4",
    "messages": [{"role": "user", "content": "你好"}],
    "max_tokens": 1024
  }'
```

#### 3. 模型列表
```
GET /glm/v1/models
```

**请求示例：**
```bash
curl http://localhost:3000/glm/v1/models \
  -H "Authorization: Bearer YOUR_API_KEY"
```

### DeepSeek 渠道（已增强）

除了原有的 OpenAI 格式外，新增 Claude 格式支持：

#### Claude 格式
```
POST /deepseek/v1/messages
```

**请求示例：**
```bash
curl -X POST http://localhost:3000/deepseek/v1/messages \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer YOUR_API_KEY" \
  -H "anthropic-version: 2023-06-01" \
  -d '{
    "model": "deepseek-v4-flash",
    "messages": [{"role": "user", "content": "1+1=?"}],
    "max_tokens": 1024
  }'
```

## 支持的模型

### GLM 模型
- `glm-4` - GLM-4 基础模型
- `glm-4-plus` - GLM-4 增强模型
- `glm-4-search` - GLM-4 联网搜索模型
- `glm-4v` - GLM-4 视觉模型
- `glm-4-flash` - GLM-4 快速模型
- `cogview-3` - CogView-3 图像生成模型

### DeepSeek 模型
- `deepseek-v4-flash` - DeepSeek V4 Flash
- `deepseek-v4-pro` - DeepSeek V4 Pro
- `deepseek-v4-vision` - DeepSeek V4 Vision
- `deepseek-v4-pro-search` - DeepSeek V4 Pro Search

## 架构说明

### Claude 格式适配器

位于 `src/adapters/claude.js`，提供：
- `convertClaudeRequest()` - 将 Claude 格式请求转换为 OpenAI 格式
- `convertOpenAIResponse()` - 将 OpenAI 格式响应转换为 Claude 格式
- `streamOpenAIToClaude()` - 流式响应转换（待实现）
- `writeClaudeSSE()` - Claude SSE 事件写入（待实现）

### GLM 渠道实现

位于 `src/glm.js`，包含：
- 三层 Token 认证体系（访客 → refresh → access）
- 消息格式转换（OpenAI ↔ GLM）
- 工具调用支持
- 文件上传支持
- 图像生成支持
- 视频生成支持

## 环境变量

```bash
# GLM Refresh Token（可选，不设置则使用访客模式）
GLM_REFRESH_TOKEN=你的refresh_token
```

### 如何获取 GLM Refresh Token

**方法 1：浏览器开发者工具（推荐）**

1. 访问 https://chatglm.cn/ 并登录
2. 打开浏览器开发者工具（F12）
3. 切换到 Network 标签
4. 刷新页面
5. 找到任意 API 请求，查看请求头中的 `Authorization: Bearer eyJ...`
6. 复制 `Bearer` 后面的内容作为 `GLM_REFRESH_TOKEN`

详细说明请参考：[GLM Token 配置指南](./GLM_TOKEN_SETUP.md)

### 访客模式

如果不配置 `GLM_REFRESH_TOKEN`，系统会自动使用访客模式（guest access）：
- ✅ 无需登录，自动获取临时 token
- ⚠️ 可能有速率限制和功能限制

## 当前限制

### Claude 格式支持
- ✅ 非流式响应已实现
- ⏳ 流式响应待实现

### GLM 功能
- ✅ 基础对话功能
- ✅ 模型列表
- ✅ OpenAI 格式支持
- ✅ Claude 格式支持
- ⏳ 工具调用（需要实际测试）
- ⏳ 文件上传（需要实际测试）
- ⏳ 图像/视频生成（需要实际测试）

## 测试结果

### DeepSeek Claude 格式 ✅
```bash
# 测试请求
curl -X POST http://localhost:3000/deepseek/v1/messages \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer sk-zhi" \
  -H "anthropic-version: 2023-06-01" \
  -d '{"model":"deepseek-v4-flash","messages":[{"role":"user","content":"1+1=?"}],"max_tokens":1024}'

# 响应
{
    "id": "msg_1782179982423-pr5b8wcz25h",
    "type": "message",
    "role": "assistant",
    "content": [
        {
            "type": "text",
            "text": "2"
        }
    ],
    "model": "deepseek-v4-flash",
    "stop_reason": "end_turn",
    "stop_sequence": null,
    "usage": {
        "input_tokens": 0,
        "output_tokens": 40
    }
}
```

### GLM 模型列表 ✅
```bash
curl http://localhost:3000/glm/v1/models -H "Authorization: Bearer sk-zhi"

# 响应包含所有 GLM 模型
```

### GLM API 调用 ⚠️
需要有效的 `GLM_REFRESH_TOKEN` 才能正常工作。访客模式可能受到限制。

## 下一步计划

1. ✅ 完成 DeepSeek Claude 格式非流式支持
2. ✅ 完成 GLM OpenAI 格式基础支持
3. ✅ 完成 GLM Claude 格式基础支持
4. ⏳ 实现 Claude 格式流式响应
5. ⏳ 测试 GLM 高级功能（工具调用、文件上传等）
6. ⏳ 添加更多错误处理和重试逻辑
7. ⏳ 性能优化和监控

## 相关文档

- [GLM 模型调用接入指南](./GLM模型调用接入指南.md) - GLM API 详细技术文档
- 主项目 README.md - 项目总体说明
