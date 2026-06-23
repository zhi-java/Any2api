# API 端点统一重构

## Goal

将按渠道分离的 API 端点结构重构为符合 OpenAI/Claude 标准的统一端点，通过 `model` 参数自动路由到正确的渠道处理器。

**用户价值**：
- 完全兼容 OpenAI 和 Claude SDK（开箱即用）
- 简化客户端配置（单一 base URL）
- 统一的模型列表（所有渠道的模型在一个端点）
- 符合行业标准

## Current State

### 现有端点结构

```javascript
// 默认端点（指向 DeepSeek）
POST /v1/chat/completions       → handleOpenAICompletion (DeepSeek)
GET  /v1/models                 → handleOpenAIModels (仅 DeepSeek)

// DeepSeek 渠道端点
POST /deepseek/v1/chat/completions  → handleOpenAICompletion
POST /deepseek/v1/messages          → handleDeepSeekClaude
GET  /deepseek/v1/models            → handleDeepSeekModels

// GLM 渠道端点
POST /glm/v1/chat/completions   → handleGLMOpenAI
POST /glm/v1/messages           → handleGLMClaude
GET  /glm/v1/models             → handleGLMModels

// 旧版端点（已废弃）
POST /api/v0/chat/completion    → handleDeepSeekCompletion
```

### 现有模型名称

**DeepSeek 模型**：
- `deepseek-v4-flash`
- `deepseek-v4-pro`
- `deepseek-v4-vision`
- `deepseek-v4-pro-search`
- `deepseek-v4-flash[1m]`（1M 上下文）
- `deepseek-v4-pro[1m]`（1M 上下文）
- `deepseek-v4-vision[1m]`（1M 上下文）

**GLM 模型**：
- `glm-4`
- `glm-4-plus`
- `glm-4-search`
- `glm-4v`
- `glm-4-flash`
- `cogview-3`

**观察**：模型名称已经包含渠道前缀（`deepseek-*`, `glm-*`），无冲突风险。

## Requirements

### 1. 统一 API 端点

#### OpenAI 格式端点
- [ ] `POST /v1/chat/completions` 支持所有渠道
  - 根据 `model` 参数路由到 `handleOpenAICompletion` 或 `handleGLMOpenAI`
  - DeepSeek 模型 → `handleOpenAICompletion`
  - GLM 模型 → `handleGLMOpenAI`

#### Claude 格式端点
- [ ] `POST /v1/messages` 支持所有渠道
  - 根据 `model` 参数路由到 `handleDeepSeekClaude` 或 `handleGLMClaude`
  - DeepSeek 模型 → `handleDeepSeekClaude`
  - GLM 模型 → `handleGLMClaude`

#### 模型列表端点
- [ ] `GET /v1/models` 返回所有渠道的模型
  - 合并 DeepSeek 和 GLM 的模型列表
  - 每个模型标注正确的 `owned_by` 字段

### 2. 模型路由器

- [ ] 创建 `src/model-router.js` 模块
  - 导出 `routeModel(modelName)` 函数
  - 返回渠道标识符：`'deepseek'` 或 `'glm'`
  - 未知模型抛出清晰的错误

**路由规则**：
```javascript
// DeepSeek: 所有以 'deepseek-' 开头的模型
'deepseek-v4-flash' → 'deepseek'
'deepseek-v4-pro' → 'deepseek'

// GLM: 所有以 'glm-' 或 'cogview-' 开头的模型
'glm-4' → 'glm'
'glm-4-plus' → 'glm'
'cogview-3' → 'glm'

// 未知
'unknown-model' → throw Error
```

### 3. 移除渠道特定端点

- [ ] 移除 `/deepseek/v1/*` 端点
- [ ] 移除 `/glm/v1/*` 端点
- [ ] 保留 `/api/v0/chat/completion`（已废弃但可能有依赖）

### 4. 文档更新

- [ ] 更新 API 文档
- [ ] 更新 README
- [ ] 更新配置示例

## Acceptance Criteria

### 功能验收

- [ ] `POST /v1/chat/completions` 支持 DeepSeek 模型（OpenAI 格式）
- [ ] `POST /v1/chat/completions` 支持 GLM 模型（OpenAI 格式）
- [ ] `POST /v1/messages` 支持 DeepSeek 模型（Claude 格式）
- [ ] `POST /v1/messages` 支持 GLM 模型（Claude 格式）
- [ ] `GET /v1/models` 返回所有渠道的模型（14 个模型）
- [ ] 未知模型返回 400 错误和清晰的错误消息

### SDK 兼容性

- [ ] OpenAI SDK 可直接使用（设置 `baseURL: 'http://localhost:3000/v1'`）
- [ ] Claude SDK 可直接使用（设置 `baseURL: 'http://localhost:3000/v1'`）

### 代码质量

- [ ] 所有文件语法检查通过
- [ ] 模型路由器有清晰的单元测试示例
- [ ] 错误处理完整

### 清理

- [ ] 旧的 `/deepseek/v1/*` 端点已移除
- [ ] 旧的 `/glm/v1/*` 端点已移除
- [ ] 未使用的导入已清理

## Out of Scope

- `/api/v0/chat/completion` 旧版端点（保留不动）
- Admin 面板端点（保留不动）
- 健康检查端点（保留不动）
- 性能优化（不在此任务范围）
- 自动化测试框架（不在此任务范围）

## Open Questions

~~所有问题已解决~~

**已确定的决策**：

1. ✅ **模型路由的边界情况**：严格验证，立即失败
   - 未知模型返回 400 错误
   - 中文错误消息：`未知模型: xxx。支持的模型: deepseek-*, glm-*, cogview-*`
   - 不使用默认渠道降级
   
2. ✅ **错误消息格式**：根据端点返回对应格式 + 中文错误提示
   - OpenAI 格式：标准 `error` 对象，包含 `type`, `param`, `code` 字段
   - Claude 格式：`type: "error"` 包装的错误对象
   - HTTP 状态码：`400 Bad Request`
   
3. ✅ **模型列表排序**：按渠道分组
   - DeepSeek 模型在前（7 个）
   - GLM 模型在后（6 个）
   - 每组内保持原有顺序

## Notes

- 项目未上线，不需要向后兼容
- 所有现有模型名称已包含渠道前缀，无冲突
- 这是一个复杂任务，需要 `design.md` 和 `implement.md`
