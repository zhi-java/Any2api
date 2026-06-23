# 项目目录重构 - 专业化与可扩展性

## Goal

重构项目目录结构，使其符合 Node.js/Express 最佳实践，清晰分层，易于扩展新渠道，易于维护。

## Current State

### 当前目录结构
```
src/
├── index.js (255 行)        # 主入口：路由定义 + 中间件 + 启动逻辑
├── model-router.js (31 行)  # 模型路由器
├── openai.js (689 行)       # DeepSeek OpenAI 格式处理
├── deepseek.js (88 行)      # DeepSeek 原生格式处理
├── glm.js (1210 行)         # GLM 处理（最大）
├── gemini.js (583 行)       # Gemini 处理
├── api-client.js (213 行)   # 统一 API 调用层
├── adapters/
│   └── claude.js (496 行)   # Claude 格式适配器
├── auth.js (496 行)         # 认证 + Token 池管理
├── session.js (141 行)      # 会话管理
├── conversation.js (149 行) # 对话管理
├── queue.js (84 行)         # 请求队列
├── logger.js (211 行)       # 日志记录
├── metrics.js (180 行)      # 指标统计
├── headers.js (235 行)      # 请求头工具
├── chat.js (318 行)         # SSE 流解析
├── pow.js (222 行)          # PoW 工作量证明
└── upload.js (115 行)       # 文件上传

总计：5716 行代码
```

### 已识别的问题

#### 1. 职责混淆
- **index.js** 混合了：路由定义、中间件、Express 配置、启动逻辑
- **渠道文件**（openai.js, glm.js, gemini.js）混合了：
  - HTTP 请求处理（Express handler）
  - 业务逻辑（消息转换、工具调用）
  - API 客户端调用
  - 格式适配

#### 2. 文件规模失衡
- `glm.js` 1210 行 - 太大，难以维护
- `openai.js` 689 行 - 偏大
- `gemini.js` 583 行 - 偏大
- **原因**：一个文件承担了太多职责

#### 3. 扩展性差
- 新增渠道需要：
  1. 创建 XXX.js（几百行）
  2. 在 index.js 添加路由
  3. 在 model-router.js 添加路由规则
  4. 可能需要新的 adapter（如果格式不同）
- **没有标准化的渠道接口**

#### 4. 代码重复
- 每个渠道文件都有类似的：
  - Express handler 结构
  - 错误处理逻辑
  - 流式/非流式分支
- Claude adapter 是独立的，但 OpenAI/Gemini 转换逻辑嵌在渠道文件中

#### 5. 缺乏分层
- 当前：`路由 → 渠道处理器（混合所有逻辑）`
- 缺少：控制器层、服务层、清晰的 API 客户端层

## Requirements

### 功能性需求
- [ ] 保持所有现有 API 端点正常工作（向后兼容）
- [ ] 保持现有功能完整（认证、日志、指标、队列、会话等）
- [ ] 不改变外部 API 行为

### 非功能性需求
- [ ] **模块化**：每个模块职责单一，边界清晰
- [ ] **分层架构**：路由 → 控制器 → 服务 → 客户端
- [ ] **可扩展性**：新增渠道只需添加对应模块，无需修改核心代码
- [ ] **代码复用**：共享逻辑抽取为通用模块
- [ ] **易于测试**：分层后便于单元测试
- [ ] **文件规模**：单文件不超过 300 行（建议）

## Acceptance Criteria

### 结构标准
- [ ] 清晰的目录分层（routes, controllers, services, channels, adapters, middleware, utils）
- [ ] 每个渠道实现遵循统一接口
- [ ] 格式适配器独立于渠道实现
- [ ] 通用工具集中在 utils/
- [ ] 中间件集中在 middleware/

### 代码质量
- [ ] 所有语法检查通过
- [ ] 所有文件符合 ESM 模块规范
- [ ] 导入路径正确更新

### 功能验证
- [ ] 所有现有端点测试通过：
  - `POST /v1/chat/completions` (OpenAI 格式)
  - `POST /v1/messages` (Claude 格式)
  - `GET /v1/models`
  - `POST /api/v0/chat/completion` (DeepSeek 原生)
  - `GET /` (健康检查)
  - Admin 面板端点
- [ ] DeepSeek 渠道正常工作
- [ ] GLM 渠道正常工作
- [ ] 日志、指标、认证等功能正常

### 可扩展性验证
- [ ] 新增渠道的步骤清晰且简单（文档化）
- [ ] 渠道之间相互独立，修改一个不影响其他

## Out of Scope

- 改变 API 行为或响应格式
- 重写业务逻辑（只是重组）
- 性能优化（除非重构引入）
- 添加新功能
- 修改配置文件格式

## Open Questions

需要确认的关键决策：

1. ✅ **分层粒度**：选择轻量级模块化重组（选项 A）
   - 原因：适合 API 代理性质，避免过度设计
   - 结构：routes/ + channels/ + adapters/ + middleware/ + utils/

2. ✅ **迁移策略**：选择渐进式迁移（选项 A）
   - 原因：风险低，每步可验证，易于调试
   - 步骤：创建结构 → 迁移 utils → 迁移 middleware → 迁移 channels → 迁移 routes

3. ✅ **渠道内部结构**：选择按职责拆分（选项 A）
   - 原因：单一职责，文件大小合理，易于测试
   - 文件：index.js + handlers.js + client.js + models.js + utils.js（可选）

## Design Decisions Summary

所有关键决策已确认，详细设计和实施计划已完成：

### 已完成的规划文档
1. ✅ **prd.md** - 需求和验收标准
2. ✅ **design.md** - 技术设计（架构、数据流、迁移策略）
3. ✅ **implement.md** - 实施计划（7 个阶段的详细步骤）

### 核心架构决策
- **分层粒度**：轻量级模块化（routes + channels + adapters + middleware + utils + services）
- **迁移策略**：渐进式迁移（7 个阶段，每阶段可独立验证）
- **渠道结构**：按职责拆分（index + handlers + client + models + utils）

### 预期成果
- 文件大小合理（< 300 行）
- 清晰的职责分离
- 易于扩展新渠道
- 易于维护和测试

### 下一步
运行 `task.py start` 开始实施重构。

## Notes

- 项目已有较好的模块化基础（api-client.js, model-router.js, adapters/）
- 核心问题是渠道文件过大、职责混淆
- 重构应保持现有架构优点（统一 API 层、模型路由器）
