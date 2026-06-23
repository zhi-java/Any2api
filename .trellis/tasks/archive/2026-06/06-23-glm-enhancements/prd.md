# GLM 渠道增强优化

## Goal

为已完成的 GLM 渠道集成添加关键增强功能，优先实现流式响应支持，然后逐步增强稳定性、测试覆盖和性能。

**用户价值**：
- 流式响应提供更好的用户体验（逐字显示而非等待完整响应）
- Token 池管理提高服务可靠性和负载能力
- 完整功能验证确保生产就绪
- 性能优化降低延迟和资源消耗

## Current State

**已实现**：
- ✅ GLM OpenAI 和 Claude 格式非流式支持
- ✅ 三层 Token 认证（guest → refresh → access）
- ✅ 响应拦截模式的格式适配器
- ✅ Claude 流式转换框架（`streamOpenAIToClaude` 和 `writeClaudeSSE` 已实现）
- ✅ 单 refresh token 模式和访客模式降级

**代码位置**：
- `src/glm.js` - GLM 渠道核心 (1,151 行)
- `src/adapters/claude.js` - Claude 格式适配器 (496 行，含完整流式框架)
- `src/openai.js` - DeepSeek Claude 处理器
- `src/index.js` - 路由注册

## Requirements

### 1. 流式响应支持（P0 - 高优先级）

**功能**：
- [ ] 重构 Claude 格式处理器，统一流式和非流式路径
- [ ] 启用 Claude 格式流式响应（`POST /deepseek/v1/messages` 和 `POST /glm/v1/messages` 支持 `stream: true`）
- [ ] 正确处理 SSE 事件流（message_start, content_block_*, message_delta, message_stop）
- [ ] 实时 token 计数和 stop_reason
- [ ] 错误处理和流中断恢复

**技术细节**：
- 适配器框架已完整实现（`streamOpenAIToClaude` + `writeClaudeSSE`）
- 重构方案：创建统一的 API 调用层，返回流或完整响应，然后统一转换
- 避免 if-else 分支，使用一致的处理流程

### 2. Token 池管理（P1 - 中优先级）

**功能**：
- [ ] 支持 `GLM_REFRESH_TOKENS` 环境变量（逗号分隔多个 token）
- [ ] 默认降级到访客模式（无需配置即可使用）
- [ ] Token 池轮询调度（round-robin）
- [ ] 从浏览器 Cookies 中提取 `chatglm_refresh_token`（文档指导）
- [ ] Token 健康检查（可选：定期验证 token 有效性）
- [ ] 自动剔除失效 token（可选）

**配置方式**：
```bash
# 方式 1: 单个 token（向后兼容）
GLM_REFRESH_TOKEN=eyJhbGciOi...

# 方式 2: 多个 tokens（新增，优先级更高）
GLM_REFRESH_TOKENS=token1,token2,token3

# 方式 3: 不配置（默认访客模式）
# (无需任何配置)
```

**技术细节**：
- 优先级：`GLM_REFRESH_TOKENS` > `GLM_REFRESH_TOKEN` > 访客模式
- Token 池实现：扩展 `GlmTokenManager` 类
- 轮询策略：简单的 round-robin，每次请求选择下一个 token
- 所有 token 组成公共池，系统自动调度

### 3. 高级功能测试（P1 - 中优先级）

**功能**：
- [ ] 验证工具调用（Tool Calling）功能
- [ ] 验证文件上传功能
- [ ] 记录测试结果和已知限制

**测试方式**：
- 创建简单的测试脚本（非完整单元测试）
- 手动运行并验证功能
- 在文档中记录结果

**不包含**：
- 图像生成（CogView）- 可能需要特殊权限
- 视频生成 - 测试耗时且需要特殊权限

**技术细节**：
- 工具调用：使用简单的天气/计算器工具测试
- 文件上传：测试图片和文档上传
- 需要有效的 `GLM_REFRESH_TOKEN` 或 `GLM_REFRESH_TOKENS`

### 4. 性能优化（移除 - 作为独立后续任务）

**不包含在本次任务中**，将作为独立任务 `glm-performance`：
- HTTP 连接复用（keep-alive）
- 请求结果缓存
- 响应压缩（gzip/brotli）
- 并发请求限流

### 5. 自动化测试（移除 - 作为独立后续任务）

**不包含在本次任务中**，将作为独立任务 `glm-testing`：
- 单元测试框架搭建（Jest/Mocha）
- 适配器单元测试
- 集成测试用例
- CI/CD 配置（GitHub Actions）

## Acceptance Criteria

### Phase 1: 流式响应（必须）
- [ ] DeepSeek Claude 格式流式响应工作正常
- [ ] GLM Claude 格式流式响应工作正常
- [ ] 流式响应的 SSE 事件顺序正确（message_start → content_block_* → message_delta → message_stop）
- [ ] Token 计数准确
- [ ] 错误时流正确终止
- [ ] 非流式功能不受影响（向后兼容）

### Phase 2: Token 池（必须）
- [ ] 支持 `GLM_REFRESH_TOKENS` 环境变量（逗号分隔）
- [ ] 向后兼容 `GLM_REFRESH_TOKEN` 单 token 模式
- [ ] 无配置时自动降级到访客模式
- [ ] 轮询选择正常工作（每次请求轮换 token）
- [ ] 文档更新：如何从浏览器 Cookies 获取 token

### Phase 3: 功能验证（必须）
- [ ] 工具调用功能验证通过
- [ ] 文件上传功能验证通过
- [ ] 记录测试结果和已知限制

### 整体验收
- [ ] 所有修改的文件通过语法检查
- [ ] 代码质量检查通过（无重大问题）
- [ ] 文档已更新
- [ ] 原有功能不受影响

## Out of Scope

- OpenAI 格式流式响应（已由底层处理器支持）
- Gemini 格式适配（超出 GLM 渠道范围）
- 生产监控和告警系统（属于运维范畴）
- **性能优化**（HTTP 连接池、缓存、压缩）- 独立后续任务
- **自动化测试**（单元测试、集成测试、CI/CD）- 独立后续任务
- **图像生成和视频生成功能验证**（可能需要特殊权限）
- **Token 健康检查和自动剔除**（可在后续优化）

## Open Questions

~~所有问题已解决~~

**已确定的决策**：

1. ✅ **流式响应实现方式**：重构整个处理器以统一两种模式
   - 创建统一的 API 调用层
   - 避免 if-else 分支
   
2. ✅ **Token 池配置方式**：`GLM_REFRESH_TOKENS` 环境变量（逗号分隔）
   - 优先级：`GLM_REFRESH_TOKENS` > `GLM_REFRESH_TOKEN` > 访客模式
   - 轮询策略：简单 round-robin
   
3. ✅ **功能测试范围**：工具调用 + 文件上传
   - 图像/视频生成暂不包含
   
4. ✅ **性能优化和自动化测试**：作为独立后续任务
   - 本次任务聚焦于核心功能

## Notes

- 这是一个复杂任务，需要 `design.md` 和 `implement.md`
- 优先级按 P0 > P1 > P2 顺序实施
- 每个阶段完成后更新任务状态
- 流式响应是最高优先级，其他功能可根据时间调整
