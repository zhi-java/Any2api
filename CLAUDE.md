# OmniAPI — AI 助手指南

## 项目概述

OmniAPI 是一个多通道 Web-to-API 代理，将 DeepSeek、GLM、Qwen、Kimi 等上游 Web 端转换为标准 OpenAI/Claude API 格式。

- **运行时**: Node.js + Express (ES modules)
- **测试**: Node.js 原生 test runner (`node --test`)
- **部署**: Docker Compose / 原生 Node
- **版本**: 见 `package.json`

## 架构概览

### 请求处理链路

```
客户端请求
  → Express 路由 (src/routes/)
  → 协议适配器 (src/protocols/*/request-adapter.js)
  → Internal Request 标准化 (src/core/internal-request.js)
  → 模型路由解析 (src/utils/model-router.js → src/core/model-resolution.js)
  → 渠道分发 (src/core/generation.js → src/channels/*/runner.js)
  → 内部事件流 (src/core/internal-events.js)
  → 协议渲染器 (src/protocols/*/renderer.js)
```

### 目录职责

| 目录 | 职责 |
|------|------|
| `src/index.js` | 入口，调用 `startServer()` |
| `src/server.js` | Express 应用创建、中间件链、启动逻辑 |
| `src/routes/` | 路由聚合：`/v1`(API)、`/admin`(管理)、`/performance`(性能) |
| `src/middleware/` | 认证、日志、错误处理、指标采集 |
| `src/core/` | 生成编排、模型解析、prompt 策略、工具调用验证、内部事件定义 |
| `src/protocols/` | 三种协议适配器+渲染器：chat-completions、claude-messages、responses |
| `src/channels/` | 四个上游渠道实现：deepseek、glm、qwen、kimi |
| `src/services/` | 认证 token 池、配置持久化、会话管理、对话亲和、文件上传、请求队列 |
| `src/utils/` | 环境变量、HTTP 头、模型路由、SSE 解析、运行时路径等工具 |
| `src/admin/` | 管理面板前端静态资源 |

### 三种 API 协议

1. **`POST /v1/chat/completions`** — OpenAI 兼容格式（默认 endpoints）
2. **`POST /v1/messages`** — Claude Messages 格式
3. **`POST /v1/responses`** — Internal Event 原生端点（不经过 chat/completions 桥接）

所有端点**仅支持流式响应**，`stream: false` 会返回 400 错误。

### 四个上游渠道

| 渠道 | 目录 | 模型示例 |
|------|------|---------|
| DeepSeek | `src/channels/deepseek/` | `deepseek-v4-pro`, `deepseek-v4-flash` |
| GLM | `src/channels/glm/` | `glm-5.2` |
| Qwen | `src/channels/qwen/` | `qwen3.7-plus`, `qwen3.7-max` |
| Kimi | `src/channels/kimi/` | `kimi-k2.6`, `kimi-k2.6-thinking` |

模型路由优先级：DeepSeek → GLM → Qwen → Kimi。客户端附加后缀（如 `[1m]`）会被自动剥离。

## 开发命令

```bash
npm start          # 启动服务 (node src/index.js)
npm run dev        # 开发模式，文件变更自动重启
npm test           # 运行所有测试 (node --test)
```

### 测试

测试使用 Node.js 原生 test runner，文件位于 `test/` 目录，结构与 `src/` 对应：

```
test/
├── channels/       # 渠道测试 (runner, stream-parser, models)
├── core/           # 核心逻辑测试 (generation, prompt-strategy, tool-validation)
├── protocols/      # 协议测试 (renderer, request-adapter)
├── utils/          # 工具测试
├── admin-auth.test.js
└── admin-config-store.test.js
```

运行单个测试文件：`node --test test/core/generation.test.js`

### Docker

```bash
make build         # 构建镜像
make up            # 启动开发环境
make up-prod       # 启动生产环境
make down          # 停止服务
make logs          # 查看日志
make test          # 健康检查
make deploy        # 一键部署 (构建+启动+测试)
```

## 关键设计模式

### 1. Internal Events 层

所有渠道 runner 输出统一的 `InternalEvent` 序列（`src/core/internal-events.js`），协议渲染器将这些事件转换为对应格式的 SSE 流。事件类型包括：`run_started`、`message_started`、`text_delta`、`reasoning_delta`、`tool_call_started`、`run_completed` 等。

### 2. Prompt 注入策略

`ENABLE_PROMPT_INJECTION` 控制是否向上游 Web 端注入兼容性 prompt（工具调用 XML 格式、角色标签等）：

- **启用时**（默认）：自动注入 `<Function_XXXX_Start/>` 触发器 + `<function_calls>` XML 模板
- **禁用时**：直接透传客户端 JSON 请求原文

核心逻辑在 `src/core/prompt-strategy.js` 的 `createPromptPlan()`。

### 3. Token 池管理

DeepSeek 使用 token 池（`src/services/auth.js`），支持：
- 多 token 轮转
- 账号自动登录获取/刷新 token
- 健康检查（定期验证空闲 token）
- 并发控制（`MAX_CONCURRENT_PER_TOKEN`）
- 死亡标记（连续错误达到阈值后标记 dead，有账号则自动刷新）

GLM 支持 refresh token 或访客模式。Qwen 和 Kimi 使用各自的 token/队列管理。

### 4. 配置系统

`src/services/config-store.js` 实现三层配置合并：
1. `DEFAULT_CONFIG` 硬编码默认值
2. 环境变量（`.env` 文件或系统环境）
3. 磁盘 `config.json`（通过管理后台修改的数据）

优先级：磁盘 > 环境变量 > 默认值。`saveConfig()` 会同步写回 `process.env`。

### 5. 工具体系

工具调用使用 XML 格式而非 JSON function calling：
- 上游 Web 端注入 `<function_calls>` XML 模板指令
- 流式解析器实时检测触发信号并提取工具调用
- 解析失败时自动重试（`src/core/tool-retry.js`）
- 工具调用验证在 `src/core/tool-validation.js`

### 6. 上下文回退

DeepSeek Pro 模型支持上下文超限时自动回退到 Flash（`src/channels/deepseek/context-budget.js`），由 `DEEPSEEK_CONTEXT_FALLBACK` 控制。

## 编码约定

### 通用规则

- 使用 ES modules (`import`/`export`)，禁止 CommonJS
- 所有新增代码必须有中文注释
- 错误处理使用 `InternalAPIError`（`src/core/errors.js`），包含 `status`、`type`、`code`、`param`
- 配置项统一通过 `getConfig()` 读取，不要直接读 `process.env`
- 日志输出使用 `console.log`/`console.warn`/`console.error`，带有渠道前缀如 `[DeepSeek]`

### 文件组织

- 每个渠道独立目录，内部文件按功能拆分：`client.js`、`runner.js`、`models.js`、`stream-parser.js`、`auth.js`
- 新渠道加入需要在 `src/core/generation.js` 的 `RUNNERS` 注册，并在 `src/utils/model-router.js` 添加路由
- 新协议加入需要在 `src/routes/api.js` 添加路由和处理函数

### 安全注意事项

- 所有面向用户的 API key 使用 `safeEqualSecret()` 做 timing-safe 比较
- 管理后台 API key 通过 `hasValidAdminAuth()` 校验
- 外部 V1 API key 通过 `isAcceptedApiKey()` 校验
- 配置文件中的敏感信息对外展示时必须 mask（`maskSecret()`）

## Trellis 工作流

项目集成 Trellis 任务管理系统（`.trellis/`），遵循三阶段开发：

### 阶段判断
- **无活跃任务** → 先分类请求，确认是否需要创建 Trellis 任务。简单对话/小改动可直接跳过。
- **planning** → 加载 `trellis-brainstorm`，完成 `prd.md`；复杂任务还需 `design.md` + `implement.md`
- **in_progress** → 派遣 `trellis-implement` → `trellis-check` → `trellis-update-spec` → commit → `/trellis:finish-work`

### 关键命令

```bash
python .trellis/scripts/task.py create "<title>" --slug <name>
python .trellis/scripts/task.py start <name>
python .trellis/scripts/task.py current --source
python .trellis/scripts/get_context.py --mode packages
```

### Spec 系统

`.trellis/spec/` 包含编码规范（目前大部分待填充），实现前应检查相关 spec 文件。修改代码后若产生新的模式/约定/教训，应更新 spec。

## 常见任务指引

### 添加新模型

1. 在对应渠道的 `models.js` 中添加模型映射
2. 如果是新渠道，参照"添加新渠道"

### 添加新渠道

1. 在 `src/channels/<name>/` 创建目录，实现 `runner.js`、`models.js`、`stream-parser.js`、`client.js`
2. 在 `src/utils/model-router.js` 添加路由规则
3. 在 `src/core/generation.js` 的 `RUNNERS` 注册
4. 在 `src/routes/api.js` 的 `/v1/models` 端点添加模型列表
5. 在 `src/services/config-store.js` 添加配置段（如有持久化需求）
6. 编写测试

### 修改 Prompt 注入逻辑

- 工具调用 XML 格式：`src/core/prompt-strategy.js`
- 提示词构建：`src/utils/response-utils.js` 的 `buildPromptFromMessages()` / `buildLatestPrompt()`
- 注入开关：`ENABLE_PROMPT_INJECTION` 环境变量

### 调试

- 设置 `CLIENT_DEBUG_LOG=true` 启用请求/响应日志
- 日志输出到 `LOG_DIR`（默认 `logs/`）
- `logs-debug/` 目录存储详细调试日志
- DeepSeek 验证：使用管理后台的 token 测试功能

## AI 协作准则

以下准则规定了 AI 助手在本项目中工作时必须遵循的行为规范。

### 任务执行原则

- **在代码上下文中理解需求**：接收到模糊或通用的指令时，以本项目的软件工程任务为背景进行解读。例如"把 methodName 改成蛇形命名法"意味着找到代码中的方法并实际修改，而非仅回复 `method_name`。
- **先读后改**：未阅读代码前不要提出修改建议。理解现有代码后再动手。
- **不预测时间**：避免给出时间估算或预测。聚焦于需要做什么，而非需要多久。
- **安全优先**：杜绝命令注入、XSS、SQL 注入等 OWASP Top 10 漏洞。发现不安全代码立即修复。
- **避免过度工程化**：
  - 只做直接要求的更改，不添加额外功能或重构无关代码
  - 不要为不可能的场景添加错误处理、回退或验证——只在系统边界（用户输入、外部 API）做校验
  - 不要为一次性操作创建辅助函数或抽象——三行相似代码优于过早抽象
  - 不要在未修改的代码上加文档字符串、注释或类型注解
- **简洁删除**：确认未使用的代码直接删除，不要用 `_vars` 重命名、`// removed` 注释等向后兼容 hack。

### 风险操作管控

执行操作前必须评估其可逆性和影响范围：

| 风险等级 | 操作类型 | 策略 |
|---------|---------|------|
| 低风险 | 编辑文件、运行测试 | 可直接执行 |
| 中风险 | 删除文件、git reset、修改依赖 | 执行前征得用户确认 |
| 高风险 | 强制推送、修改已发布提交、操作 CI/CD | 必须征得用户确认 |

特别需要注意的操作：
- 删除文件/分支、数据库表、终止进程、`rm -rf`
- 强制推送、`git reset --hard`、修改已发布提交
- 推送代码、创建 PR/Issue、发送消息到外部服务
- 上传内容到第三方工具（pastebin、gist 等）——内容可能被缓存或索引

**阻塞处理原则**：遇到障碍时不要用破坏性操作绕过问题。识别根因并修复底层问题，而非使用 `--no-verify` 等绕过手段。发现不熟悉的文件、分支或配置时，先调查再操作。

**确认范围**：一次授权不等于持续授权。每次风险操作独立确认，授权范围严格限定在指定操作内。

### 工具使用策略

- **代码探索优先用 Agent**：探索代码库时使用 `subagent_type=Explore` 的 Agent 工具，而非直接运行搜索命令
- **文件操作用专用工具**：Read > cat/head/tail，Edit > sed/awk，Write > echo 重定向。Bash 仅用于需要 shell 执行的实际系统命令
- **最大化并行调用**：独立工具调用在同一消息中并行发出。有依赖关系的调用才顺序执行
- **WebFetch 重定向**：遇到重定向时立即用返回的新 URL 重新请求

### 输出效率

- **直击要点**：先给答案/操作，后给理由。跳过填充词和开场白
- **精炼输出**：一句话能说完不用三句。输出聚焦于需要用户决策的事项、关键里程碑状态、改变计划的障碍
- **按需解释**：仅在用户理解必需时展开解释。代码注释不受此限——注释按实际需要编写
