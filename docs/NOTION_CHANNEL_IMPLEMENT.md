# Notion AI 渠道接入 — 实现计划

> 基于 [NOTION_CHANNEL_DESIGN.md](./NOTION_CHANNEL_DESIGN.md)

---

## 实现顺序

```
1. models.js         (无依赖，纯数据定义)
2. session.js        (仅依赖 Node.js fs 模块)
3. stream-parser.js  (无依赖，纯流处理)
4. client.js         (依赖 session)
5. handlers.js       (依赖 client + stream-parser)
6. index.js          (依赖 handlers + models)
─── 路由集成 ───
7. model-router.js   (加 Notion 模型检查)
8. routes/api.js     (加 notion channel dispatch)
9. src/index.js      (启动时加载 session)
10. .env.example     (加配置注释)
```

## 验收标准

| # | 检查项 | 验证方式 |
|---|--------|---------|
| 1 | 加载 Probe JSON 后能正确提取 cookies/user_id/space_id | `loadSession()` 返回完整 SessionInfo |
| 2 | Stream parser 能将 NDJSON 转换为 content/done 事件 | `parseNotionNDJSON()` yield 正确事件类型 |
| 3 | Client 能构造正确的请求头和 Referer | 检查 buildHeaders 输出 |
| 4 | OpenAI 流式端点能正常 SSE 输出 | `curl -N http://localhost:3000/v1/...` |
| 5 | OpenAI 非流式端点返回 JSON | `curl http://localhost:3000/v1/...` |
| 6 | Claude 端点能正常响应 | `curl -H "anthropic-version: ..."` |
| 7 | 模型列表包含 Notion 模型 | `curl /v1/models` |
| 8 | 未配置 NOTION_PROBE_PATH 时 Notion 模型返回 5xx | 合理的错误提示 |

## 验证命令

```bash
# 测试 SS
node src/index.js
```