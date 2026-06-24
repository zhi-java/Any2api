# 防幻觉 & 工具调用完整性 —— 系统性架构策略

## 问题画像

text-prompt 模拟模式下，模型工具调用失效有 3 种来源：

```
来源 A: 模型不遵守格式 → 输出破碎/空标签
来源 B: 模型混淆 thinking vs content → thinking 被截断
来源 C: 系统 prompt 泄漏 → [System]:... 混入输出
```

## 已实施的 6 层防护

### 第 1 层：Prompt 工程（防源）

`buildToolInstructions()` 改进：

```diff
- Old: "do not answer normally. Output exactly one XML block"
+ New: "You may first provide your thinking, then append the tool call block"
+   + 正例 3 个（含文本前导 + 空工具调用 + 多工具）
+   + 反面示例 4 个（空标签、嵌套标签、字符串替代数组、markdown fence）
+   + 明确要求 assistant_response 必须存在（JSON 模式）
```

### 第 2 层：鲁棒解析（防格式异常）

```
parseToolCallsFromText() — 6 策略逐级降级:
  1. <tool_calls> XML 提取
  2. parseVirtualToolJSON (JSON 格式)
  3. 裸 JSON 兜底
  4. recoverToolCallsFromText (全文深度扫描)
  5. 【新】防死循环 — 剥离空标签 + 内容消毒
  6. 【新】防泄漏 — sanitizeModelOutput 清除 prompt 残片
```

### 第 3 层：校验流水线（防幻觉）

```
validateToolCallsPipeline:
  Step 1: validateToolChoice()    — tool_choice=required/none/specific
  Step 2: validateToolNames()     — 白名单去幻觉
  Step 3: sanitizeToolArguments() — 非法参数兜底 "{}"
```

### 第 4 层：Thinking 降级（防截断）

```
当 content 是破碎工具调用、但 thinking 有内容时:
  content = fullThinking
  finish_reason = "stop" (而非 "tool_use")
```

### 第 5 层：内容消毒（防泄漏）

```
sanitizeModelOutput() 自动清除:
  • [System]: x-anthropic-* headers
  • [User]: / [Assistant]: 消息泄漏
  • [Tool result ...] 工具结果泄漏
  • [Tool calling instructions] 指令复读
  • Available tools: 工具列表复读
  • You (have access to|are behind)... 指令残片
```

### 第 6 层：日志诊断（可视性）

```
detectFailedToolParse() 输出：
  [Tool abort] Stripped malformed <tool_calls>...
  [Content sanitize] Stripped N chars of leaked prompt artifacts
  [Tool recovery] Recovered N tool call(s) via depth-scan fallback
  [Tool validation] Removed N hallucinated tool(s): ...
  [Tool args] Invalid JSON in "funcName": ...
```

## 失效率评估

| 失效模式 | 概率 | 防护层 | 最终状态 |
|---------|------|--------|---------|
| 模型输出空`<tool_calls>`标签 | 高 | 第2层-策略5 | → 剥离为纯文本 |
| 模型输出嵌套标签 | 中 | 第2层-策略5 | → 剥离为纯文本 |
| thinking被截断 | 高 | 第4层 | → thinking作回复 |
| 幻觉工具名 | 中 | 第3层 | → 过滤 + warning |
| 非法参数格式 | 中 | 第3层 | → 兜底"{}" |
| System prompt泄漏 | 低 | 第5层 | → 自动消毒 |
| 工具调用+文本混合 | 低 | 第1层+第2层 | → content/toolCalls分离 |
| 正确工具调用 | - | 全部 | ✅ 正常输出 |
