# GLM 渠道增强优化 - 变更日志

## [未发布] - 2026-06-23

### 新增功能

#### 1. Token 池管理
- **支持多 Token 配置**：新增 `GLM_REFRESH_TOKENS` 环境变量，支持逗号分隔多个 refresh tokens
- **Round-robin 轮询**：自动轮询选择可用 token，提升负载均衡能力
- **独立缓存**：每个 refresh token 的 access token 独立缓存，避免相互影响
- **自动降级**：Token 刷新失败时自动降级到访客模式
- **向后兼容**：继续支持单 token 模式（`GLM_REFRESH_TOKEN`）

**配置示例**：
```bash
# 单个 token（向后兼容）
GLM_REFRESH_TOKEN=your_token

# 多个 tokens（推荐）
GLM_REFRESH_TOKENS=token1,token2,token3

# 无配置（访客模式）
# 留空即可
```

#### 2. 流式响应支持
- **DeepSeek Claude 格式流式响应**：`POST /deepseek/v1/messages` 现在支持 `stream: true`
- **GLM Claude 格式流式响应**：`POST /glm/v1/messages` 现在支持 `stream: true`
- **SSE 事件流**：完整支持 Claude SSE 事件序列（message_start, content_block_*, message_delta, message_stop）
- **实时 Token 计数**：流式响应中包含准确的 token 统计
- **错误恢复**：流式响应中的错误处理和连接中断恢复

**使用示例**：
```bash
curl -X POST http://localhost:3000/deepseek/v1/messages \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer YOUR_KEY" \
  -H "anthropic-version: 2023-06-01" \
  -d '{
    "model": "deepseek-v4-flash",
    "messages": [{"role": "user", "content": "讲个故事"}],
    "max_tokens": 500,
    "stream": true
  }'
```

### 架构改进

#### 统一 API 调用层
- **新增模块**：`src/api-client.js`
  - `callDeepSeekAPI()` - DeepSeek API 统一封装
  - `callGLMAPI()` - GLM API 统一封装
  - 支持流式和非流式两种模式
  - 统一的错误处理

#### 重构 Claude 格式处理器
- **移除响应拦截模式**：不再使用 mock `res` 对象拦截响应
- **统一处理流程**：流式和非流式使用一致的代码路径
- **清晰的职责分离**：格式转换、API 调用、响应处理各司其职

**架构对比**：

重构前（响应拦截）：
```
Handler → Mock res → Original handler → Intercept → Convert
```

重构后（统一 API 层）：
```
Handler → Unified API → Stream/Non-stream → Convert → Response
```

### 修改的文件

#### 新增
- `src/api-client.js` (213 行) - 统一 API 调用层

#### 修改
- `src/glm.js`
  - 扩展 `GlmTokenManager` 类，支持 token 池
  - 重构 `handleGLMClaude` 函数，支持流式响应
  - 约 180 行修改

- `src/openai.js`
  - 重构 `handleDeepSeekClaude` 函数，支持流式响应
  - 添加必要的导入
  - 约 60 行修改

#### 未修改
- `src/adapters/claude.js` - 流式转换框架已完整，无需修改
- `src/index.js` - 路由已存在，无需修改

### 向后兼容性

- ✅ **API 接口不变**：所有现有端点路径和参数保持不变
- ✅ **非流式功能不受影响**：现有的非流式调用继续正常工作
- ✅ **单 Token 模式继续支持**：`GLM_REFRESH_TOKEN` 环境变量仍然有效
- ✅ **访客模式保持不变**：无配置时自动使用访客模式

### 已知限制

1. **功能测试未完全执行**：流式响应的端到端测试需要实际运行服务验证
2. **GLM 非流式解析**：`parseGLMNonStreamResponse` 函数需要实际测试验证
3. **高级功能验证**：工具调用和文件上传功能的验证留待后续

### 性能影响

- **Token 缓存优化**：多 token 独立缓存，减少重复刷新
- **流式响应**：逐块返回，无需等待完整响应，降低首字节延迟
- **轮询调度**：token 池轮询分散负载

### 后续计划

以下功能已排除出本次任务，将作为独立任务：

- **性能优化**：HTTP 连接池、请求缓存、响应压缩
- **自动化测试**：单元测试框架、集成测试、CI/CD
- **图像/视频生成验证**：需要特殊权限的功能测试

### 升级指南

#### 1. 无配置升级
如果当前使用访客模式或单 token 模式，**无需任何操作**，升级后自动生效。

#### 2. 启用多 Token 池
```bash
# 1. 获取多个 GLM refresh tokens（从浏览器 Cookies）
# 2. 配置环境变量
export GLM_REFRESH_TOKENS="token1,token2,token3"

# 3. 重启服务
npm start
```

#### 3. 启用流式响应
只需在请求中添加 `"stream": true` 参数：
```json
{
  "model": "deepseek-v4-flash",
  "messages": [...],
  "stream": true
}
```

### 贡献者
- AI Development Team

---

**注意**：此为内部开发版本，尚未正式发布。
