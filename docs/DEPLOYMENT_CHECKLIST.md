# GLM 渠道集成 - 部署检查清单

## 部署前检查

### 1. 代码完整性
- [x] 所有文件已保存
- [x] 语法检查通过
- [x] 无未使用的导入
- [x] 错误处理完整

### 2. 配置文件
- [ ] 检查是否存在 `.env` 文件
- [ ] 如需使用 GLM，配置 `GLM_REFRESH_TOKEN`
- [ ] 验证现有的 API Keys 配置

### 3. 依赖项
- [x] 无新增 npm 依赖
- [x] 所有导入都是项目内部模块

### 4. 端口和路由
- [x] 新增路由不与现有路由冲突
- [x] 保持向后兼容（原有端点不受影响）

### 5. 文档
- [x] 用户文档已更新
- [x] API 文档已更新  
- [x] 架构规范已更新
- [x] Token 配置指南已创建

## 部署步骤

### 1. 停止当前服务
```bash
# 找到并停止 Node.js 进程
ps aux | grep "node src/index.js"
kill -9 <PID>
```

### 2. 备份（可选）
```bash
cp -r C:/Projects/AI/deepseek-2api-4242-master/deepseek-2api-4242 \
     C:/Projects/AI/deepseek-2api-4242-master/deepseek-2api-4242-backup-$(date +%Y%m%d)
```

### 3. 验证文件
```bash
cd C:/Projects/AI/deepseek-2api-4242-master/deepseek-2api-4242

# 检查语法
node --check src/glm.js
node --check src/adapters/claude.js
node --check src/openai.js
node --check src/index.js
```

### 4. 配置环境变量（可选）
```bash
# 编辑 .env 文件
nano .env

# 添加（如果需要 GLM 完整功能）
GLM_REFRESH_TOKEN=your_refresh_token_here
```

### 5. 启动服务
```bash
npm start

# 或使用 PM2（推荐生产环境）
pm2 start src/index.js --name deepseek-api
pm2 save
```

### 6. 验证部署
```bash
# 检查服务状态
curl http://localhost:3000/admin/api/stats

# 测试 DeepSeek Claude 格式
curl -X POST http://localhost:3000/deepseek/v1/messages \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer YOUR_API_KEY" \
  -H "anthropic-version: 2023-06-01" \
  -d '{
    "model": "deepseek-v4-flash",
    "messages": [{"role": "user", "content": "Hello"}],
    "max_tokens": 100
  }'

# 测试 GLM 模型列表
curl http://localhost:3000/glm/v1/models \
  -H "Authorization: Bearer YOUR_API_KEY"

# 测试 GLM OpenAI 格式（需要 GLM_REFRESH_TOKEN）
curl -X POST http://localhost:3000/glm/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer YOUR_API_KEY" \
  -d '{
    "model": "glm-4",
    "messages": [{"role": "user", "content": "你好"}],
    "stream": false
  }'
```

## 验证清单

### 基础功能
- [ ] 服务成功启动（无错误日志）
- [ ] 原有端点正常工作
- [ ] 管理面板可访问

### 新增功能
- [ ] DeepSeek Claude 格式返回正确响应
- [ ] GLM 模型列表返回正常
- [ ] GLM API 调用正常（如配置了 token）

### 性能
- [ ] 响应时间正常（< 3 秒首字节）
- [ ] 内存占用稳定
- [ ] 无内存泄漏迹象

### 错误处理
- [ ] 无效请求返回 400 错误
- [ ] 缺少认证返回 401 错误
- [ ] 后端错误返回 500 错误
- [ ] 错误消息清晰易懂

## 回滚计划

如果部署出现问题：

### 1. 快速回滚
```bash
# 停止当前服务
pm2 stop deepseek-api

# 恢复备份
rm -rf C:/Projects/AI/deepseek-2api-4242-master/deepseek-2api-4242
mv C:/Projects/AI/deepseek-2api-4242-master/deepseek-2api-4242-backup-YYYYMMDD \
   C:/Projects/AI/deepseek-2api-4242-master/deepseek-2api-4242

# 重启服务
pm2 start deepseek-api
```

### 2. 部分回滚
如果只有 GLM 功能有问题，可以：
- 从环境变量中移除 `GLM_REFRESH_TOKEN`
- 重启服务（GLM 将使用访客模式）
- 原有功能不受影响

### 3. 禁用新端点
临时在 `src/index.js` 中注释掉新路由：
```javascript
// app.post('/glm/v1/chat/completions', handleGLMCompletion);
// app.post('/glm/v1/messages', handleGLMClaude);
// app.post('/deepseek/v1/messages', handleDeepSeekClaude);
```

## 监控建议

### 日志监控
```bash
# 实时查看日志
pm2 logs deepseek-api

# 或使用 tail
tail -f /path/to/log/file
```

### 关键指标
- 请求成功率（目标 > 95%）
- 平均响应时间（目标 < 3s）
- Token 刷新失败率
- 错误日志数量

### 告警设置
- 连续 5 分钟错误率 > 10%
- 内存使用 > 80%
- Token 刷新连续失败 3 次

## 已知限制

1. **GLM 访客模式**：未配置 `GLM_REFRESH_TOKEN` 时使用访客模式可能有速率限制
2. **Claude 格式流式**：当前仅支持非流式响应，流式响应框架已准备但未启用
3. **并发限制**：建议配置反向代理（Nginx/Caddy）进行请求限流

## 下一步优化

1. 实现 Claude 格式流式响应
2. 添加 Token 池管理（支持多个 refresh token）
3. 添加请求缓存机制
4. 实现更详细的监控指标
5. 添加自动化测试

## 支持

- 技术文档：`docs/GLM_INTEGRATION.md`
- Token 配置：`docs/GLM_TOKEN_SETUP.md`
- 架构规范：`.trellis/spec/backend/api-integration.md`
- 变更记录：`docs/CHANGELOG.md`

---

**部署日期**：_____________  
**部署人员**：_____________  
**验证状态**：[ ] 通过  [ ] 失败  
**备注**：_____________________________
