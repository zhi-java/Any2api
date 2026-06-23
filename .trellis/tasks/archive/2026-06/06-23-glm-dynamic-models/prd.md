# GLM 动态模型列表

## Goal

~~实现从 GLM API 动态获取真实的、最新的支持模型列表，替代当前硬编码的 `MODEL_MAP`。~~

**更新后的目标**：添加 GLM-5.2 最新模型到硬编码列表

**原因**：经过 API 探索和浏览器真实验证，确认：
1. GLM-5.2 是官方最新旗舰模型
2. 动态 API 需要用户 token，成本高收益低
3. 硬编码方案简单可靠，符合当前架构

## Current State

### 硬编码模型列表
```javascript
// src/glm.js
const MODEL_MAP = {
  'glm-4':         { assistantId: DEFAULT_ASSISTANT_ID, plusModel: false, search: false, type: 'chat' },
  'glm-4-plus':    { assistantId: DEFAULT_ASSISTANT_ID, plusModel: true,  search: false, type: 'chat' },
  'glm-4-search':  { assistantId: DEFAULT_ASSISTANT_ID, plusModel: true,  search: true,  type: 'chat' },
  'glm-4v':        { assistantId: DEFAULT_ASSISTANT_ID, plusModel: true,  search: false, type: 'vision' },
  'glm-4-flash':   { assistantId: DEFAULT_ASSISTANT_ID, plusModel: false, search: false, type: 'chat' },
  'cogview-3':     { assistantId: COGVIEW_ASSISTANT_ID, plusModel: false, search: false, type: 'image' },
};
```

### 已知的 GLM API 端点
- `https://chatglm.cn/chatglm/user-api/guest/access` - 获取访客 token
- `https://chatglm.cn/chatglm/user-api/user/refresh` - 刷新 token
- `https://chatglm.cn/chatglm/backend-api/assistant/stream` - 对话接口
- `https://chatglm.cn/chatglm/backend-api/assistant/file_upload` - 文件上传

### 问题
- ❓ GLM 是否提供模型列表 API？
- ❓ 如果有，端点是什么？需要什么认证？
- ❓ 返回的数据格式是什么？

## Requirements

### 研究阶段（Phase 1）
- [ ] 测试可能的 GLM API 端点
  - `/chatglm/backend-api/assistant/list`
  - `/chatglm/backend-api/models`
  - `/chatglm/user-api/models`
  - 其他可能的端点
- [ ] 使用访客 token 或用户 token 测试
- [ ] 分析返回的数据格式
- [ ] 记录 API 行为和限制

### 实现阶段（Phase 2 - 取决于研究结果）

**方案 A**：如果 API 可用
- [ ] 实现动态获取模型列表函数
- [ ] 添加缓存机制（避免频繁调用）
- [ ] 实现降级到硬编码列表（API 失败时）
- [ ] 更新 `/v1/models` 端点使用动态列表

**方案 B**：如果 API 不可用
- [ ] 创建手动更新脚本
- [ ] 添加模型列表版本检查
- [ ] 文档化更新流程

## Acceptance Criteria

### 研究阶段
- [ ] 确定 GLM 是否提供模型列表 API
- [ ] 如果有 API，记录端点、认证、数据格式
- [ ] 如果没有 API，确定替代方案

### 实现阶段（如果 API 可用）
- [ ] `/v1/models` 返回动态获取的 GLM 模型
- [ ] 缓存生效，不会每次请求都调用 GLM API
- [ ] API 失败时降级到硬编码列表
- [ ] 新增模型自动出现在列表中

### 实现阶段（如果 API 不可用）
- [ ] 提供手动更新工具
- [ ] 文档化更新流程

## Out of Scope
- DeepSeek 模型列表（已经是硬编码，不在此任务范围）
- 自动检测新模型并通知（未来功能）

## Research Findings

### ✅ 发现潜在端点

**端点**: `POST https://chatglm.cn/chatglm/backend-api/assistant/list`

**状态**: 存在，但需要真实用户 token（非访客 token）

**测试结果**:
- GET 请求 → 405 Method Not Allowed
- POST 请求（访客 token）→ 401 "You need login to access this resource"
- POST 请求（用户 token）→ **待测试**

**推测**:
- 可能返回所有可用的 assistant（包括模型）
- 数据格式未知，需要实际测试

### ⚠️ 限制

1. **认证要求**: 需要配置 `GLM_REFRESH_TOKEN`
2. **用途不明**: 不确定返回的是所有模型还是用户自定义 assistant
3. **数据格式未知**: 需要实际测试才能确定

## Open Questions

1. **GLM API 端点探索**：需要实际测试才能确定 GLM 是否提供模型列表 API
2. **缓存策略**：如果有 API，应该缓存多久？
3. **降级策略**：API 失败时的具体行为？

## Notes

这是一个**研究主导**的任务，需要先探索 GLM API 能力，然后根据发现决定实施方案。
