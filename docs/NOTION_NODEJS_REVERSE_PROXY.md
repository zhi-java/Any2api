# Notion AI 反向代理 — 认证与会话管理 & HTTP 请求伪造

> 基于 [Notion2API](https://github.com/yourusername/notion2api) 项目（Go）逆向分析，聚焦两个核心话题。
> 只关注这两点，因为其他一切（OpenAI 兼容层、流式解析、分发策略等）都建立在此基础之上。

---

## 目录

- [一、认证与会话管理](#一认证与会话管理)
  - [1.1 Notion 认证体系](#11-notion-认证体系)
  - [1.2 Probe JSON 与会话文件](#12-probe-json-与会话文件)
  - [1.3 会话发现与自动补齐](#13-会话发现与自动补齐)
  - [1.4 账号登录流程（验证码）](#14-账号登录流程验证码)
  - [1.5 手动导入（Cookie / Probe JSON）](#15-手动导入cookie--probe-json)
  - [1.6 会话刷新机制](#16-会话刷新机制)
  - [1.7 会话持久化与 Probe 文件存储](#17-会话持久化与-probe-文件存储)
- [二、HTTP 请求伪造（反向代理核心）](#二http-请求伪造反向代理核心)
  - [2.1 Notion API 端点完整列表](#21-notion-api-端点完整列表)
  - [2.2 必须的请求头](#22-必须的请求头)
  - [2.3 NotionAIClient 实现](#23-notionaiclient-实现)
  - [2.4 Referer 策略](#24-referer-策略)
  - [2.5 Proxy 与 Resin 代理支持](#25-proxy-与-resin-代理支持)
  - [2.6 传输层缓存](#26-传输层缓存)
  - [2.7 请求体构建详解（runInferenceTranscript）](#27-请求体构建详解runinferencetranscript)
  - [2.8 浏览器回退机制](#28-浏览器回退机制)
  - [2.9 Debug 模式与请求抓取](#29-debug-模式与请求抓取)

---

## 一、认证与会话管理

### 1.1 Notion 认证体系

Notion AI 不使用 OAuth 或 API Token。它依赖**浏览器 Cookie 认证**。

核心 Cookie 只有 1 个：

| Cookie 名称 | 用途 | 典型值 |
|---|---|---|
| `token_v2` | 主认证令牌 | 32 位十六进制字符串 |

这个 `token_v2` 是登录 Notion 后浏览器自动持有的会话令牌。所有对 Notion API 的请求都在 HTTP 请求头中携带这个 Cookie。

除了 Cookie，每个请求还必须携带以下两个身份标识头：

| Header | 用途 | 示例 |
|---|---|---|
| `x-notion-active-user-header` | 当前活跃用户 UUID | `xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx` |
| `x-notion-space-id` | 当前工作空间 ID | 32 位十六进制字符串（无连字符） |
| `notion-client-version` | Notion 客户端版本号 | `25.3.56.8` |

**关键结论**：要在 Node.js 中实现 Notion AI 的「反向代理」，本质上就是：
1. 拿到这 4 个值（token_v2, user_id, space_id, client_version）
2. 发送 HTTP 请求时伪造出和浏览器一模一样的请求头和 Cookie
3. 把 Notion 返回的流式 NDJSON 结果转发给客户端

### 1.2 Probe JSON 与会话文件

每个 Notion 账号对应一个 **Probe JSON 文件**，它是会话的持久化载体。

#### 1.2.1 结构定义

```go
// Go 原版结构
type probePayload struct {
    Email         string        `json:"email"`
    UserID        string        `json:"user_id"`
    UserName      string        `json:"user_name,omitempty"`
    SpaceID       string        `json:"space_id"`
    SpaceViewID   string        `json:"space_view_id,omitempty"`
    SpaceName     string        `json:"space_name,omitempty"`
    ClientVersion string        `json:"client_version"`
    Cookies       []ProbeCookie `json:"cookies"`
}
```

```typescript
// Node.js 版本
interface ProbePayload {
  email: string;
  user_id: string;
  user_name?: string;
  space_id: string;
  space_view_id?: string;
  space_name?: string;
  client_version: string;
  cookies: { name: string; value: string }[];
}
```

#### 1.2.2 完整示例

```json
{
  "email": "user@example.com",
  "user_id": "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
  "user_name": "John Doe",
  "space_id": "abcdef1234567890abcdef1234567890",
  "space_view_id": "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
  "space_name": "John's Workspace",
  "client_version": "25.3.56.8",
  "cookies": [
    { "name": "token_v2", "value": "abc123def456..." }
  ]
}
```

#### 1.2.3 必需字段

| 字段 | 必须？ | 说明 |
|---|---|---|
| `email` | ✅ | 用户邮箱，用于标识账号 |
| `user_id` | ✅ | 用户 UUID |
| `space_id` | ✅ | 目标 Notion 工作空间 ID（32 位 hex） |
| `client_version` | ✅ | 从 Notion 网页版获取的版本号 |
| `cookies` | ✅ | 至少包含 `token_v2` |
| `user_name` | ❌ | 可选，会自动发现补齐 |
| `space_name` | ❌ | 可选，会自动发现补齐 |
| `space_view_id` | ❌ | 可选，会自动发现补齐 |

#### 1.2.4 LoadSessionInfo 实现（加载 Probe 文件）

当服务启动或切换账号时，从 Probe JSON 文件加载会话信息：

```go
// Go 原版逻辑（简化）
func loadSessionInfo(probePath string, userName string, spaceName string) (SessionInfo, error) {
    rawBytes, err := os.ReadFile(probePath)
    var payload probePayload
    json.Unmarshal(rawBytes, &payload)

    // 校验必需字段
    if payload.Email == "" || payload.UserID == "" || payload.SpaceID == "" || payload.ClientVersion == "" {
        return error("probe json missing required fields")
    }
    if len(payload.Cookies) == 0 {
        return error("probe json missing cookies")
    }

    // 补齐可选字段
    localPart := payload.Email[:strings.Index(payload.Email, "@")]
    resolvedUserName := firstNonEmpty(userName, payload.UserName, localPart)
    resolvedSpaceName := firstNonEmpty(spaceName, payload.SpaceName, resolvedUserName+"'s Space")

    return SessionInfo{
        ProbePath:     absPath,
        ClientVersion: payload.ClientVersion,
        UserID:        payload.UserID,
        UserEmail:     payload.Email,
        UserName:      resolvedUserName,
        SpaceID:       payload.SpaceID,
        SpaceViewID:   payload.SpaceViewID,
        SpaceName:     resolvedSpaceName,
        Cookies:       payload.Cookies,
    }, nil
}
```

```typescript
// Node.js 实现
interface SessionInfo {
  probePath: string;
  clientVersion: string;
  userId: string;
  userEmail: string;
  userName: string;
  spaceId: string;
  spaceViewId: string;
  spaceName: string;
  cookies: { name: string; value: string }[];
}

function firstNonEmpty(...values: (string | undefined | null)[]): string {
  for (const v of values) {
    if (v && v.trim()) return v.trim();
  }
  return '';
}

function loadSessionInfo(
  probePath: string,
  userName?: string,
  spaceName?: string
): SessionInfo {
  const raw = fs.readFileSync(probePath, 'utf-8');
  const payload: ProbePayload = JSON.parse(raw);

  if (!payload.email || !payload.user_id || !payload.space_id || !payload.client_version) {
    throw new Error('probe json missing required fields');
  }
  if (!payload.cookies || payload.cookies.length === 0) {
    throw new Error('probe json missing cookies');
  }

  const localPart = payload.email.split('@')[0];
  const resolvedUserName = firstNonEmpty(userName, payload.user_name, localPart);
  const resolvedSpaceName = firstNonEmpty(spaceName, payload.space_name, `${resolvedUserName}'s Space`);

  return {
    probePath,
    clientVersion: payload.client_version,
    userId: payload.user_id,
    userEmail: payload.email,
    userName: resolvedUserName,
    spaceId: payload.space_id,
    spaceViewId: payload.space_view_id || '',
    spaceName: resolvedSpaceName,
    cookies: payload.cookies,
  };
}
```

### 1.3 会话发现与自动补齐

#### 1.3.1 为什么需要补齐

Probe JSON 中 `spaceViewId`, `userName`, `spaceName` 可能是空的。如果为空，AI 请求可能失败。系统通过调用 Notion 内部 API 来自动发现这些值。

#### 1.3.2 补齐策略

```go
// Go 原版：ensureSessionLiveMetadata
func (c *NotionAIClient) ensureSessionLiveMetadata(ctx context.Context) {
    // 如果所有元数据已齐全，跳过
    if !c.probeMetadataNeedsBackfill() && c.Session.SpaceViewID != "" {
        return
    }

    // 第一步：调用 loadUserContent
    body, err := c.postJSONWithReferer(ctx,
        c.Config.NotionUpstream().API("loadUserContent"),
        map[string]any{},
        "application/json",
        c.Config.NotionUpstream().HomeURL(),
    )

    // 从响应中解析：Email, UserName, SpaceID, SpaceViewID, SpaceName
    var payload map[string]any
    json.Unmarshal(body, &payload)
    meta := parseLoadUserContentMetadata(payload)
    // 用发现的值覆盖缺失字段...
    c.Session.UserName = firstNonEmpty(meta.UserName, c.Session.UserName)
    c.Session.SpaceName = firstNonEmpty(meta.SpaceName, c.Session.SpaceName)
    c.Session.SpaceViewID = firstNonEmpty(meta.SpaceViewID, c.Session.SpaceViewID)

    // 如果还不够，第二步：调用 getSpacesInitial
    if c.Session.SpaceViewID == "" {
        body, err = c.postJSONWithReferer(ctx,
            c.Config.NotionUpstream().API("getSpacesInitial"),
            map[string]any{},
            "application/json",
            c.Config.NotionUpstream().HomeURL(),
        )
        bootstrap := parseSpacesInitial(payload, c.Session.UserID)
        c.Session.SpaceViewID = bootstrap.SpaceViewID
        // ...
    }

    // 持久化回 Probe 文件
    c.persistSessionProbe()
}
```

#### 1.3.3 使用的 API

| API | 端点 | 用途 |
|---|---|---|
| 用户内容加载 | `POST /api/v3/loadUserContent` | 获取用户基本信息和当前空间 |
| 空间初始化 | `POST /api/v3/getSpacesInitial` | 获取用户所有空间信息，找到目标空间 |

两个 API 都不需要请求体参数（`{}`）。

### 1.4 账号登录流程（验证码）

#### 1.4.1 完整流程

```
Step 1: 用户输入邮箱
    │
    ▼
POST /admin/accounts/login/start  { email: "user@example.com" }
    │
    ▼
系统在服务端启动浏览器自动化（Puppeteer/Playwright）：
  ├─ 打开 https://www.notion.so/login
  ├─ 输入邮箱
  ├─ 点击"Continue with email"
  ├─ Notion 发送 6 位验证码到邮箱
  └─ 等待用户输入验证码
    │
    ▼
Step 2: 用户接收验证码，输入
    │
    ▼
POST /admin/accounts/login/verify  { email: "...", code: "123456" }
    │
    ▼
系统在浏览器中：
  ├─ 输入验证码
  ├─ 完成登录
  ├─ 提取 Cookie（token_v2）
  ├─ 调用 loadUserContent / getSpacesInitial 获取元数据
  ├─ 生成 Probe JSON 文件
  ├─ 保存 Storage State（浏览器持久化状态）
  └─ 标记账号为 READY
```

#### 1.4.2 数据存储

登录成功后，每个账号产生 3 个文件：

```
/data/notion_accounts/{email_hash}/
├── probe.json              # 会话 Probe JSON（核心）
├── storage_state.json      # 浏览器持久化状态（可选，用于回退）
└── pending_state.json      # 登录状态跟踪（过程文件）
```

### 1.5 手动导入（Cookie / Probe JSON）

如果已有 Cookie（或不走验证码流程），可以直接手动导入。

#### 1.5.1 API 端点

```
POST /admin/accounts/manual
```

#### 1.5.2 请求体格式

```json
{
  "email": "user@example.com",
  "user_id": "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx",
  "space_id": "xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
  "space_name": "Workspace Name",
  "client_version": "25.3.56.8",
  "cookie_header": "token_v2=abc123def456; another_cookie=value",
  "probe_json_text": "{...完整 probe json...}",
  "active": true
}
```

#### 1.5.3 处理逻辑

```go
// Go 原版：handleAdminAccountManualImport 的核心逻辑
func buildImportedSession(ctx, cfg, req) (probe, storage, status, error) {
    // 1. 解析 probe_json_text（如果有）
    // 2. 从 cookie_header 中解析 Cookie
    // 3. 如果缺少 Email/UserID/SpaceID/ClientVersion → 尝试自动发现
    //    POST /api/v3/loadUserContent → 补齐
    // 4. 生成 Probe JSON 文件
    // 5. 生成 Storage State 文件
    // 6. 生成 Pending State 文件
    // 7. 写入账号配置
    // 8. 如果 active=true，设为当前活跃账号
}
```

```typescript
// Node.js 中手动导入一个账号
async function manualImportAccount(req: ManualImportRequest): Promise<void> {
  // 1. 解析 Cookie
  const cookies = req.cookieHeader
    ? req.cookieHeader.split(';').map(p => {
        const [name, ...rest] = p.trim().split('=');
        return { name: name.trim(), value: rest.join('=').trim() };
      })
    : [];

  // 2. 解析 Probe JSON
  let probeFromText: Partial<ProbePayload> = {};
  if (req.probeJsonText) {
    probeFromText = JSON.parse(req.probeJsonText);
  }

  // 3. 合并字段（显式传入的字段优先）
  const probe: ProbePayload = {
    email: req.email || probeFromText.email || '',
    user_id: req.user_id || probeFromText.user_id || '',
    user_name: req.user_name || probeFromText.user_name || '',
    space_id: req.space_id || probeFromText.space_id || '',
    space_view_id: probeFromText.space_view_id || '',
    space_name: req.space_name || probeFromText.space_name || '',
    client_version: req.client_version || probeFromText.client_version || '',
    cookies: cookies.length > 0 ? cookies : (probeFromText.cookies || []),
  };

  // 4. 如有必要，自动发现缺失字段
  if (!probe.email || !probe.user_id || !probe.space_id || !probe.client_version) {
    const discovered = await discoverMetadata(probe);
    // 合并发现的结果...
  }

  // 5. 写入文件系统
  const accountDir = `/data/notion_accounts/${hashEmail(probe.email)}`;
  fs.mkdirSync(accountDir, { recursive: true });
  fs.writeFileSync(`${accountDir}/probe.json`, JSON.stringify(probe, null, 2));

  // 6. 注册到账号池
  registerAccount(probe);
}
```

### 1.6 会话刷新机制

#### 1.6.1 为什么需要刷新

Notion 的 `token_v2` 有时效性（通常 1~7 天），过期后 API 调用会返回 401 或 403。

#### 1.6.2 刷新策略

```go
// 配置
type SessionRefreshConfig struct {
    Enabled          bool  // 启用自动刷新
    IntervalSec      int   // 刷新间隔（默认 900s = 15 分钟）
    StartupCheck     bool  // 启动时立即检查
    RetryOnAuthError bool  // API 请求遇到认证错误时触发刷新
    AutoSwitch       bool  // 当前账号失效时自动切换到下一个可用账号
}
```

#### 1.6.3 刷新机制

**方式一：定时刷新**
- 每隔 `interval_sec` 执行一次
- 使用浏览器自动化重新打开 Notion，获取新 Cookie
- 更新 Probe JSON 文件

**方式二：按需刷新（出错时触发）**
- 当 API 请求返回认证相关错误时触发
- 尝试刷新 Cookie 后重试请求
- 如果刷新失败，标记账号为失败，切换到下一个账号

### 1.7 会话持久化与 Probe 文件存储

#### 1.7.1 文件布局

```
/app/data/notion_accounts/
├── user1_example/       # email 哈希或 slug 目录
│   ├── probe.json        # 会话 Probe JSON
│   ├── storage_state.json# 浏览器存储状态
│   └── pending_state.json# 登录过程状态
├── user2_example/
│   ├── probe.json
│   ├── storage_state.json
│   └── pending_state.json
```

#### 1.7.2 文件路径解析

```go
// Go 原版：自动计算账号文件路径
func ensureAccountPaths(cfg AppConfig, account NotionAccount) NotionAccount {
    slug := accountPathSlug(account.Email)
    baseDir := filepath.Join(cfg.LoginHelper.SessionsDir, slug)
    account.ProbeJSON = filepath.Join(baseDir, "probe.json")
    account.StorageStatePath = filepath.Join(baseDir, "storage_state.json")
    account.PendingStatePath = filepath.Join(baseDir, "pending_state.json")
    account.ProfileDir = baseDir
    return account
}
```

#### 1.7.3 账号持久化到 SQLite

除了文件系统，账号也会持久化到 SQLite 数据库，目的是在重启后不需要重新导入账号。

---

## 二、HTTP 请求伪造（反向代理核心）

### 2.1 Notion API 端点完整列表

以下是对 Notion 内部 API 端点的完整总结。所有这些端点的 **Base URL** 是 `https://www.notion.so`。

| 端点 | 方法 | Content-Type | 用途 |
|---|---|---|---|
| `/api/v3/runInferenceTranscript` | POST | `application/json` 或 `application/x-ndjson` | ⭐ **AI 推理核心**。发送 prompt 给 AI，返回流式 NDJSON |
| `/api/v3/saveTransactionsFanout` | POST | `application/json` | 创建/更新 thread、保存消息等事务 |
| `/api/v3/syncRecordValuesSpaceInitial` | POST | `application/json` | 加载 thread 和消息数据 |
| `/api/v3/getInferenceTranscriptsForUser` | POST | `application/json` | 获取用户历史对话列表 |
| `/api/v3/markInferenceTranscriptSeen` | POST | `application/json` | 标记对话已读 |
| `/api/v3/loadUserContent` | POST | `application/json` | 加载用户和工作空间信息 |
| `/api/v3/getSpacesInitial` | POST | `application/json` | 获取用户所有工作空间 |
| `/api/v3/getUploadFileUrl` | POST | `application/json` | 获取文件上传预签名 URL |
| `/api/v3/getFollowUpQuestions` | POST | `application/json` | 获取后续建议问题 |

### 2.2 必须的请求头

这是实现反向代理中最关键的环节。**每个请求必须伪造出和浏览器一模一样的请求头**。

#### 2.2.1 完整请求头列表

```go
// Go 原版：NotionAIClient.baseHeaders
func (c *NotionAIClient) baseHeaders(accept string, referer string) map[string]string {
    upstream := c.Config.NotionUpstream()
    return map[string]string{
        // 核心认证
        "cookie":                      c.cookieHeader(),           // token_v2=xxx
        "x-notion-active-user-header": c.Session.UserID,          // 用户 UUID
        "x-notion-space-id":           c.Session.SpaceID,         // 空间 ID

        // 客户端身份
        "notion-client-version":       c.Session.ClientVersion,   // 版本号
        "notion-audit-log-platform":   "web",                     // 固定值

        // HTTP 标准头
        "accept":                      accept,                    // 见下方说明
        "content-type":                "application/json",
        "accept-language":             c.acceptLanguageHeader(),  // 从 Cookie 或默认 "en-US,en;q=0.9"

        // 同源策略
        "origin":                      upstream.OriginURL,        // https://www.notion.so
        "referer":                     firstNonEmpty(referer, upstream.AIURL()),

        // 浏览器特征（关键！）
        "user-agent":                  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36",
        "sec-ch-ua":                   `"Google Chrome";v="145", "Not?A_Brand";v="8", "Chromium";v="145"`,
        "sec-ch-ua-mobile":            "?0",
        "sec-ch-ua-platform":          `"Windows"`,

        // Fetch 元数据
        "sec-fetch-dest":              "empty",
        "sec-fetch-mode":              "cors",
        "sec-fetch-site":              "same-origin",
    }
}
```

```typescript
// Node.js 实现：构造请求头
function buildHeaders(
  session: SessionInfo,
  accept: string,
  referer: string
): Record<string, string> {
  const cookieHeader = session.cookies
    .map(c => `${c.name}=${c.value}`)
    .join('; ');

  return {
    // 核心认证
    'cookie': cookieHeader,
    'x-notion-active-user-header': session.userId,
    'x-notion-space-id': session.spaceId,

    // 客户端身份
    'notion-client-version': session.clientVersion,
    'notion-audit-log-platform': 'web',

    // HTTP 标准头
    'accept': accept,
    'content-type': 'application/json',
    'accept-language': 'en-US,en;q=0.9',

    // 同源策略
    'origin': 'https://www.notion.so',
    'referer': referer || 'https://www.notion.so/ai',

    // 浏览器特征
    'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36',
    'sec-ch-ua': '"Google Chrome";v="145", "Not?A_Brand";v="8", "Chromium";v="145"',
    'sec-ch-ua-mobile': '?0',
    'sec-ch-ua-platform': '"Windows"',

    // Fetch 元数据
    'sec-fetch-dest': 'empty',
    'sec-fetch-mode': 'cors',
    'sec-fetch-site': 'same-origin',
  };
}
```

#### 2.2.2 Accept 头的选择

- **普通 JSON 请求**：`accept: application/json`
- **NDJSON 流式请求**（runInferenceTranscript）：`accept: application/x-ndjson`

分辨逻辑在 Go 代码中：

```go
accept := "application/json"
if strings.Contains(strings.ToLower(strings.TrimSpace(contentType)), "application/x-ndjson") {
    accept = "application/x-ndjson"
}
```

#### 2.2.3 Accept-Language 的获取

优先从 Cookie 中的 `NEXT_LOCALE` 或 `notion_locale` 读取；如果没有，默认 `en-US,en;q=0.9`。

```go
func (c *NotionAIClient) acceptLanguageHeader() string {
    for _, name := range []string{"NEXT_LOCALE", "notion_locale"} {
        if locale := normalizeLocaleHeader(c.cookieValue(name)); locale != "" {
            return locale
        }
    }
    return "en-US,en;q=0.9"
}
```

#### 2.2.4 Node.js HTTP 请求示例

```typescript
// 使用 undici 或内置 http/https 模块发送请求
async function postJSON(
  session: SessionInfo,
  url: string,
  payload: unknown,
  opts?: { contentType?: string; referer?: string }
): Promise<Buffer> {
  const contentType = opts?.contentType || 'application/json';
  const headers = buildHeaders(
    session,
    contentType.includes('ndjson') ? 'application/x-ndjson' : 'application/json',
    opts?.referer || ''
  );
  headers['content-type'] = contentType;

  const body = JSON.stringify(payload);

  const response = await fetch(url, {
    method: 'POST',
    headers,
    body,
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`${url} failed: ${response.status} ${text}`);
  }

  return Buffer.from(await response.arrayBuffer());
}
```

### 2.3 NotionAIClient 实现

#### 2.3.1 客户端结构

```go
// Go 原版
type NotionAIClient struct {
    Session       SessionInfo      // 当前会话
    Config        AppConfig        // 配置
    AccountEmail  string           // 账号邮箱
    ProxyResolver *ProxyResolver   // 代理解析器
    Timeout       time.Duration    // 请求超时
    PollInterval  time.Duration    // 轮询间隔
    PollMaxRounds int              // 最大轮询次数
    HTTPClient    *http.Client     // HTTP 客户端
    browserRunInferenceFallback    // 浏览器回退函数（可选）
}
```

#### 2.3.2 构造方法

```go
func newNotionAIClientWithMode(
    session SessionInfo,
    cfg AppConfig,
    accountEmail string,
    streaming bool,  // true = 流式模式（不设客户端超时）
) *NotionAIClient {
    normalizedCfg := normalizeConfig(cfg)
    resolver := NewProxyResolver(normalizedCfg)
    upstream := normalizedCfg.NotionUpstream()
    transport := cachedNotionHTTPTransport(normalizedCfg, accountEmail, resolver, upstream)
    timeout := requestTimeout(normalizedCfg)  // 默认 180s

    clientTimeout := timeout
    if streaming {
        timeout = streamRequestTimeout(normalizedCfg)  // 默认 900s
        clientTimeout = 0  // 流式模式不设客户端超时
    }

    return &NotionAIClient{
        Session:       session,
        Config:        normalizedCfg,
        AccountEmail:  accountEmail,
        ProxyResolver: resolver,
        Timeout:       timeout,
        PollInterval:  time.Duration(maxFloat(normalizedCfg.PollIntervalSec, 0.5)) * time.Second,
        PollMaxRounds: maxInt(normalizedCfg.PollMaxRounds, 1),
        HTTPClient: &http.Client{
            Timeout:   clientTimeout,   // 流式 = 0（不超时）
            Transport: transport,
        },
    }
}
```

```typescript
// Node.js 实现
interface NotionAIClientOptions {
  session: SessionInfo;
  config: AppConfig;
  accountEmail: string;
  streaming?: boolean;
}

class NotionAIClient {
  session: SessionInfo;
  config: AppConfig;
  accountEmail: string;
  timeout: number;        // ms
  httpClient: FetchType;

  constructor(opts: NotionAIClientOptions) {
    this.session = opts.session;
    this.config = opts.config;
    this.accountEmail = opts.accountEmail;
    this.timeout = opts.streaming
      ? (opts.config.timeoutSec || 900) * 1000
      : (opts.config.timeoutSec || 180) * 1000;

    // HTTP 客户端使用自定义 fetch 或 undici
    this.httpClient = createConfiguredFetch({
      timeout: opts.streaming ? 0 : this.timeout,
      // Proxy 配置见下文
    });
  }
}
```

### 2.4 Referer 策略

不同的 API 调用需要不同的 Referer。Referer 错误可能会导致 Notion 返回 403。

```go
func (c *NotionAIClient) requestReferer(url string, payload map[string]any) string {
    endpoint := strings.TrimSpace(url)
    switch {
    case strings.Contains(endpoint, "runInferenceTranscript"):
        if booleanValue(payload["createThread"]) {
            // 新对话 → https://www.notion.so/ai
            return c.Config.NotionUpstream().AIURL()
        }
        // 已有 thread → https://www.notion.so/chat?t=THREAD_ID&wfv=chat
        return c.chatReferer(c.requestThreadID(payload))

    case strings.Contains(endpoint, "saveTransactionsFanout"):
        return c.chatReferer(c.requestThreadID(payload))

    case strings.Contains(endpoint, "syncRecordValuesSpaceInitial"):
        return c.chatReferer(c.requestThreadID(payload))

    case strings.Contains(endpoint, "markInferenceTranscriptSeen"):
        return c.chatReferer(c.requestThreadID(payload))

    case strings.Contains(endpoint, "getInferenceTranscriptsForUser"):
        return c.Config.NotionUpstream().AIURL()

    default:
        return c.Config.NotionUpstream().AIURL()
    }
}
```

Referer 计算公式：
```go
func (c *NotionAIClient) chatReferer(threadID string) string {
    base := strings.TrimRight(c.Config.NotionUpstream().OriginURL, "/")
    clean := strings.ReplaceAll(threadID, "-", "")  // 去掉 UUID 连字符
    if clean == "" {
        return base + "/ai"
    }
    return base + "/chat?t=" + clean + "&wfv=chat"
}
```

```typescript
// Node.js 实现
function chatReferer(originUrl: string, threadId: string): string {
  const base = originUrl.replace(/\/+$/, '');
  const clean = threadId.replace(/-/g, '');  // UUID 去连字符
  if (!clean) return `${base}/ai`;
  return `${base}/chat?t=${clean}&wfv=chat`;
}
```

### 2.5 Proxy 与 Resin 代理支持

#### 2.5.1 传输层配置

```go
func cachedNotionHTTPTransport(cfg AppConfig, accountEmail string, resolver *ProxyResolver, upstream NotionUpstream) *http.Transport {
    tlsConfig := &tls.Config{
        InsecureSkipVerify: true,  // ✅ 跳过 TLS 证书验证
    }
    if strings.TrimSpace(upstream.TLSServerName) != "" {
        tlsConfig.ServerName = upstream.TLSServerName
    }
    proxyFunc := upstream.ProxyFunc()

    transport := &http.Transport{
        TLSClientConfig: tlsConfig,
        Proxy: func(req *http.Request) (*url.URL, error) {
            if resolver != nil {
                proxyURL, _, err := resolver.ResolveProxyForRequest(accountEmail, req.URL)
                if err != nil { return nil, err }
                if proxyURL != nil { return proxyURL, nil }
            }
            if proxyFunc == nil { return nil, nil }
            return proxyFunc(req)
        },
    }
    return transport
}
```

#### 2.5.2 代理解析器

支持多种代理模式：

```go
// 配置中的代理模式
type ProxyPolicy struct {
    Mode    string  // "none" | "http" | "socks5" | "resin"
    URL     string  // 代理地址
    Resin   ResinConfig  // Resin 粘性代理
}
```

#### 2.5.3 代理头注入

当使用 Resin 代理时，还可以注入额外请求头：

```go
// 在请求发送前注入额外头
if c.ProxyResolver != nil {
    if _, extraHeaders, resolveErr := c.ProxyResolver.ResolveProxyForRequest(
        c.AccountEmail, req.URL,
    ); resolveErr == nil {
        for key, value := range extraHeaders {
            req.Header.Set(key, value)
        }
    }
}
```

此外，还需调用 `ApplyHost(req)` 处理自定义 Host 头：

```go
func (u NotionUpstream) ApplyHost(req *http.Request) {
    if req == nil || strings.TrimSpace(u.HostHeader) == "" { return }
    req.Host = u.HostHeader
    req.Header.Set("Host", u.HostHeader)
}
```

### 2.6 传输层缓存

相同配置的 HTTP Transport 会被缓存复用，避免为每个请求创建新的 TLS 连接：

```go
type notionHTTPTransportCacheKey struct {
    UpstreamBaseURL       string
    UpstreamOriginURL     string
    UpstreamHostHeader    string
    UpstreamTLSServerName string
    UpstreamUseEnvProxy   bool
    ProxyMode             string
    ProxyURL              string
    // ...更多代理配置字段
    AccountEmailKey       string
}

var notionTransportCache = struct {
    mu    sync.RWMutex
    items map[notionHTTPTransportCacheKey]*http.Transport
}{items: map[notionHTTPTransportCacheKey]*http.Transport{}}
```

```typescript
// Node.js 实现
const transportCache = new Map<string, Agent>();

function getCachedAgent(configKey: string): Agent {
  if (transportCache.has(configKey)) {
    return transportCache.get(configKey)!;
  }
  // 创建新的 Agent（如 HTTPS Agent + Proxy Agent）
  const agent = new https.Agent({
    rejectUnauthorized: false,  // InsecureSkipVerify
  });
  transportCache.set(configKey, agent);
  return agent;
}
```

### 2.7 请求体构建详解（runInferenceTranscript）

#### 2.7.1 核心请求体

这是整个项目最重要的请求体，直接决定了 AI 返回什么。

```go
// 构建 thread 的请求（创建或延续）
// 端点：POST /api/v3/runInferenceTranscript
// Content-Type: application/x-ndjson  ← 注意不是 application/json
```

**请求体结构**（id-thread 模式，延续已有 thread）：

```json
{
  "id": "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx",
  "spaceId": "xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
  "threadId": "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx",
  "transactions": [
    {
      "id": "step-uuid-1",
      "shardId": 1234,
      "spaceId": "...",
      "transactions": [
        {
          "type": "update",
          "operations": [
            {
              "pointer": {
                "table": "thread",
                "id": "thread-uuid",
                "spaceId": "..."
              },
              "path": [],
              "command": "set",
              "args": {
                "type": "workflow",
                "lastEditedTime": 1712345678000
              }
            },
            {
              "pointer": {
                "table": "thread_view",
                "id": "thread-view-uuid",
                "spaceId": "..."
              },
              "path": [],
              "command": "set",
              "args": {/* ... */}
            },
            {
              "pointer": {
                "table": "step",
                "id": "step-uuid-1",
                "spaceId": "..."
              },
              "path": [],
              "command": "set",
              "args": {
                "type": "user",
                "value": [
                  {"type": "text", "text": "用户输入的 prompt 文本"}
                ],
                "attachments": [],
                "id": "step-uuid-1",
                "parent_id": "thread-uuid",
                "parent_table": "thread",
                "created_time": 1712345678000,
                "last_edited_time": 1712345678000,
                "aligned_space_id": "..."
              }
            },
            {
              "pointer": {
                "table": "step",
                "id": "step-uuid-2",
                "spaceId": "..."
              },
              "path": [],
              "command": "set",
              "args": {
                "type": "config",
                "value": {
                  "type": "workflow",
                  "model": "claude-sonnet-4-6",
                  "enableAgentAutomations": true,
                  "enableAgentIntegrations": true,
                  "searchScopes": [],
                  "useWebSearch": false,
                  "useReadOnlyMode": false,
                  "writerMode": false,
                  // ... 大量 feature flags
                },
                "id": "step-uuid-2",
                "parent_id": "thread-uuid",
                "parent_table": "thread",
                "created_time": 1712345678001,
                "last_edited_time": 1712345678001
              }
            }
          ]
        }
      ]
    }
  ],
  "createThread": false,
  "model": "claude-sonnet-4-6",
  "type": "workflow"
}
```

**创建新 thread 的请求**（`createThread: true`，不传 `threadId`）：

```json
{
  "id": "random-uuid",
  "spaceId": "...",
  "transactions": [...],
  "createThread": true,
  "model": "claude-sonnet-4-6",
  "type": "workflow"
}
```

#### 2.7.2 工作流配置（Config Step Value）

```typescript
function buildWorkflowConfigValue(notionModel: string, useWebSearch: boolean): object {
  return {
    type: 'workflow',
    model: notionModel,           // Notion 模型 ID
    enableAgentAutomations: true,
    enableAgentIntegrations: true,
    enableCustomAgents: true,
    enableAgentDiffs: true,
    enableAgentUpdatePagePatch: true,
    enableCsvAttachmentSupport: true,
    enableDatabaseAgents: false,
    enableAgentThreadTools: false,
    enableScriptAgent: true,
    enableScriptAgentSlack: true,
    enableScriptAgentMail: true,
    enableScriptAgentCalendar: true,
    enableCreateAndRunThread: true,
    enableAgentGenerateImage: true,
    useWebSearch: useWebSearch,
    searchScopes: useWebSearch ? [{ type: 'everything' }] : [],
    useReadOnlyMode: false,
    writerMode: false,
    isCustomAgent: false,
    modelFromUser: true,
    // 实际上还有 30+ 个 flag...
  };
}
```

#### 2.7.3 文件上传事务

当用户上传文件时，需要先获取上传 URL，上传完成后在 thread 中加入 attachment step：

```go
// Step 1: 获取上传预签名 URL
// POST /api/v3/getUploadFileUrl
// 响应包含 signedUploadPostUrl、postHeaders、fields 等

// Step 2: 使用 signedUploadPostUrl 上传文件（multipart/form-data）

// Step 3: 在 thread 中加入 attachment step 事务
{
  "type": "user",
  "value": [{
    "type": "text",
    "text": "用户 prompt"
  }],
  "attachments": [{
    "name": "file.pdf",
    "contentType": "application/pdf",
    "source": "notion",
    "fileId": "...",
    "sizeBytes": 12345
  }],
  // ...
}
```

### 2.8 浏览器回退机制

#### 2.8.1 为什么需要回退

当 HTTP NDJSON 流式请求被 Notion 的 `trust-rule-denied` 错误拒绝时，可以使用浏览器自动化（Puppeteer/Playwright）作为回退。

```go
func (c *NotionAIClient) runInferenceTranscriptWithFallback(ctx, payload, threadID, sink) (result, error) {
    // 先尝试 HTTP NDJSON 方式
    parsed, err := c.runInferenceTranscriptHTTP(ctx, payload, threadID, sink)

    // 如果被 trust-rule-denied 拒绝，回退到浏览器
    if !isTrustRuleDeniedInferenceError(err) {
        return parsed, err  // 其他错误直接返回
    }

    // 启动无头浏览器，在浏览器中完成推理
    body, fallbackErr := c.runInferenceTranscriptInBrowser(fallbackCtx, payload)

    // 解析浏览器返回的 NDJSON
    return consumeNDJSONStream(strings.NewReader(body), threadID, sink)
}
```

#### 2.8.2 超时策略

```go
// 根据请求体大小动态计算超时
func browserFallbackTimeoutForPayload(parent context.Context, payload map[string]any) time.Duration {
    timeout := 60 * time.Second  // 基础 60s
    payloadBytes := json.Marshal(payload).len()
    if payloadBytes > 12 * 1024 {
        extraBytes := payloadBytes - 12 * 1024
        extraSteps := (extraBytes + 4 * 1024 - 1) / (4 * 1024)
        timeout += time.Duration(extraSteps) * 5 * time.Second
        if timeout > 120 * time.Second {  // 最大 120s
            timeout = 120 * time.Second
        }
    }
    return boundedTimeout(parent, timeout)
}
```

### 2.9 Debug 模式与请求抓取

开启 `debug_upstream: true` 后，每次 API 调用都会 dump 请求体和元数据到临时文件，便于调试。

```json
{
  "debug_upstream": true
}
```

每次调用 `runInferenceTranscript` 或 `saveTransactionsFanout` 时，会写入：
- `tmp_last_runInferenceTranscript_body.json` — 请求体
- `tmp_last_runInferenceTranscript_meta.json` — URL 和请求头元数据

对于 NDJSON 流式请求，dump 的是发送给 Notion 的 JSON 请求体（不是流式响应）。

```go
func (c *NotionAIClient) captureDebugUpstreamRequest(url string, headers map[string]string, payload map[string]any, body []byte) {
    if !c.Config.DebugUpstream { return }
    // 根据 URL 选择文件名
    switch {
    case strings.Contains(url, "runInferenceTranscript"):
        bodyPath = "tmp_last_runInferenceTranscript_body.json"
        metaPath = "tmp_last_runInferenceTranscript_meta.json"
    case strings.Contains(url, "saveTransactionsFanout"):
        bodyPath = "tmp_last_saveTransactionsFanout_body.json"
        metaPath = "tmp_last_saveTransactionsFanout_meta.json"
    default:
        return
    }
    // 写入文件和元数据
    os.WriteFile(bodyPath, body, 0600)
    os.WriteFile(metaPath, metaBytes, 0600)
}
```

---

## 附录：关键配置字段速查

```json
{
  "api_key": "your-openai-api-key",
  "admin": { "password": "admin-password" },

  "upstream_base_url": "https://www.notion.so",
  "upstream_origin": "https://www.notion.so",
  "upstream_host_header": "",
  "upstream_tls_server_name": "",
  "upstream_use_env_proxy": false,

  "active_account": "user@example.com",
  "accounts": [
    {
      "email": "user@example.com",
      "probe_json": "/data/notion_accounts/user/probe.json",
      "disabled": false,
      "priority": 0,
      "hourly_quota": 0,
      "max_concurrency": 1
    }
  ],

  "login_helper": {
    "sessions_dir": "/app/data/notion_accounts",
    "timeout_sec": 120
  },
  "session_refresh": {
    "enabled": true,
    "interval_sec": 900,
    "startup_check": true,
    "retry_on_auth_error": true,
    "auto_switch_account": true
  },

  "timeout_sec": 180,
  "poll_interval_sec": 1.5,
  "poll_max_rounds": 40,

  "features": {
    "use_web_search": true,
    "writer_mode": false,
    "ai_surface": "ai_module",
    "thread_type": "workflow"
  },

  "debug_upstream": false
}
```