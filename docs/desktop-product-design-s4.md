# OmniAPI Desktop Product Design — S4 Soft Product

> Status: **Product Design Locked** (2026-07-11)  
> Visual system: [S4 Soft Product](design-system-s4-soft-product.md)  
> Architecture baseline: **Scheme A (Tray Console) + Scheme C (First-run Wizard)**  
> Interactive prototype: [`desktop-prototype-s4.html`](desktop-prototype-s4.html)  
> Shell tech: **Tauri 2**  
> Implementation: [`../desktop/`](../desktop/)

---

## 1. Product one-liner

**OmniAPI Desktop** = 本机一键运行的多渠道 AI 代理网关。  
装上 → 配渠道 → 复制地址 → 给 Cursor / 任意 OpenAI 兼容客户端用。

不是运维大屏，不是终端驾驶舱。默认体验必须像「友好的本地 AI 基础设施」。

---

## 2. Goals & non-goals

### Goals
1. 5 分钟内完成：安装 → 登录/免密进入 → 添加至少 1 个渠道 → 复制 Endpoint
2. 关窗不停服；托盘可感知健康状态
3. 首页永远先回答：开没开、地址是什么、下一步做什么
4. 深度监控/日志存在，但不抢主路径

### Non-goals (v1)
- 远程多节点集群管理
- 暗黑工业风默认皮肤
- 首页上的高密度热力/蜂窝矩阵
- 在渲染进程内重写协议层

---

## 3. System architecture

```
┌──────────────────────────────────────────────┐
│ Desktop Shell (Tauri 2)                        │
│  - Tray + notifications                       │
│  - Main window (S4 UI)                        │
│  - First-run wizard                           │
│  - Secure local store (API keys / tokens)     │
└──────────────────────┬───────────────────────┘
                       │ spawn / health / IPC
                       ▼
┌──────────────────────────────────────────────┐
│ OmniAPI Core (existing Node service)          │
│  /v1/*  /admin/*  metrics  queues  channels   │
└──────────────────────────────────────────────┘
```

**Rule:** Core 保持可独立 `node src/index.js` / Docker 运行。桌面只是一等客户端 + 生命周期管理器。

### Process model
| Event | Behavior |
|-------|----------|
| App launch | Start Core if not healthy; wait `/admin/api/health` |
| Close main window | Hide to tray; Core keeps running |
| Tray Quit | Confirm → stop Core → exit shell |
| Core crash | Auto-restart with backoff; tray turns red; notify once per window |

---

## 4. Information architecture

### Navigation (main window)
| ID | Label | Purpose | Density |
|----|-------|---------|---------|
| `home` | 首页 | 开关态、Endpoint、引导、轻量 KPI、渠道摘要 | Comfort |
| `channels` | 渠道 | 渠道卡片 + 能力 + 测通入口 | Comfort |
| `credentials` | 凭据 | 按渠道管理 Token/账密 | Form |
| `monitor` | 监控 | RPM / 延迟 / 错误（次级） | Medium |
| `logs` | 日志 | 排障列表 | Medium |
| `settings` | 设置 | 端口展示、自启、通知、高级开关 | Form |

API Keys 管理放在 **设置 → 访问密钥**，不单独占一级导航（降低首启认知负担）。  
现有 Admin SPA 可继续保留 `apiKeys` 路由；桌面 IA 合并到设置。

### First-run wizard (fullscreen, once)
1. Welcome  
2. Pick channels to enable (DeepSeek / Qwen / Kimi / GLM)  
3. Add credentials (token or account)  
4. One-click test  
5. Show local endpoint + copy snippets  
6. Finish → Home  

Wizard state stored in desktop local config: `onboarding.completed = true`.

### Tray surface
Compact popover (~360×480):
- Status header (running / attention / stopped)
- RPM + queue mini stats
- Channel lights (4 max)
- Actions: 打开面板 / 复制地址 / 重启网关 / 退出

---

## 5. Key screens (S4 layout)

### 5.1 Welcome (wizard)
- Large title: 「把网页模型变成本地 API」
- Sub: 3 步完成接入
- Primary: 开始设置
- Secondary: 我已有配置，直接进入

### 5.2 Home (default)
Priority stack:
1. Service switch + status word  
2. Endpoint well + **复制 API 地址** (single primary CTA)  
3. Onboarding checklist (until complete)  
4. 4 soft KPIs  
5. Channel summary cards  
6. Optional light trend (collapsed on small height)

### 5.3 Channels
Grid of large soft cards:
- Name + status chip
- Available/total credentials
- Capabilities chips (text/thinking/search/…)
- Actions: 管理凭据 / 测试

### 5.4 Credentials
Left channel tabs, right list + add form.
Empty state CTA: 「添加第一个 Token」

### 5.5 Monitor
Keep charts, but:
- Page title 「监控」
- Helper text: 详细运维视图；日常看首页即可
- No raw terminal aesthetic

### 5.6 Settings
Sections:
- 通用：开机自启、关闭主窗行为、语言
- 接入：默认端口只读说明、复制 base URL
- 访问密钥：server API keys
- 通知：队列满 / 全渠道失败
- 高级：prompt injection、conversation affinity（现有 runtime 开关）

---

## 6. Interaction principles

1. **One primary CTA per view**
2. **Copy is a first-class action** (endpoint, curl, Cursor snippet)
3. **Status = color + text** (never color alone)
4. **Progressive disclosure**: advanced ops behind Monitor/Logs/Settings
5. **Friendly errors**: “Qwen 凭据失效，请更新 Token” > raw stack
6. **Motion** 150–250ms; respect reduced-motion
7. **Desktop chrome** light, matches canvas; no traffic-light decoration required in web admin

---

## 7. Content & microcopy (Chinese default)

| Context | Copy |
|---------|------|
| Home title | 你好，网关已就绪 / 还需完成设置 |
| Switch on | 运行中 |
| Switch degraded | 需关注 |
| Switch off/unavail | 已停止 / 不可用 |
| Primary CTA | 复制 API 地址 |
| Wizard done | 可以去 Cursor 里粘贴 Base URL 了 |
| Tray running | OmniAPI 运行中 |
| Quit confirm | 退出将停止本地网关，确定吗？ |

---

## 8. Data mapping (existing APIs)

| UI need | Source |
|---------|--------|
| Health / channels | `GET /admin/api/stats`, `/admin/api/health` |
| Endpoint | `stats.serverUrl + '/v1'` |
| KPIs | `logStats`, `metrics`, `queue` |
| Credentials CRUD | `/admin/api/channels/:id/config|credentials` |
| Test channel | `POST /admin/api/channels/:id/test` |
| Metrics series | `/performance/api/timeseries` |
| Logs | `/admin/api/logs` |
| Runtime settings | `GET/PATCH /admin/api/config` |

Desktop shell adds:
- `core.start|stop|restart`
- `app.getPaths` (logs dir)
- secure credential vault (optional wrap over config-store)

---

## 9. Security defaults

1. Bind `127.0.0.1` by default in desktop mode  
2. Admin auth via existing session cookie / API key  
3. Tokens never fully displayed after save (prefix only)  
4. Clipboard copy OK for endpoint; tokens require explicit reveal  
5. First launch generates/uses configured API key flow already present  

---

## 10. Visual application (S4)

Reuse tokens from design system:
- Accent `#4F46E5`
- Canvas `#FAFBFF`
- Cards white + soft shadow
- Radius 18–22px on major panels
- Plus Jakarta / Inter + mono for endpoint

Brand mark: rounded square gradient indigo→cyan with **O**.

---

## 11. Delivery phases

### Phase 0 — Done
- S4 tokens in Admin CSS
- Soft Product Home in Admin SPA

### Phase 1 — Desktop MVP (recommended next engineering)
1. Tauri shell + tray
2. Spawn existing Core
3. Embed Admin UI (or ship desktop-prototype flows into shell)
4. Wizard gate on first launch
5. Copy endpoint + autostart option

### Phase 2 — Product polish
1. Native credential forms with vault
2. Channel test in wizard
3. Notifications for degraded/queue full
4. Snippet packs (Cursor / Claude Code / curl)

### Phase 3 — Optional
1. Appearance skins (S1/S5)
2. Deep Trace inspector
3. Auto-update channel for shell vs core versioning

---

## 12. Acceptance criteria (desktop MVP)

- [ ] Cold start → healthy Core without terminal
- [ ] First-run wizard completable without docs
- [ ] Home shows endpoint and one-click copy
- [ ] Close window keeps gateway alive
- [ ] Tray color reflects healthy / degraded / stopped
- [ ] At least one channel credential add + test path works
- [ ] S4 visual language consistent across wizard/home/tray

---

## 13. Open decisions (defaults chosen)

| Topic | Default |
|-------|---------|
| Shell tech | **Tauri 2** (lighter; system WebView) |
| Window size | 1180×760, min 960×640 |
| Close behavior | Hide to tray |
| Wizard skip | Allowed via “直接进入” |
| Deep monitor | Secondary nav, not home |

If product later needs pure ops mode, add Settings → Appearance → compact/dark skins without changing default onboarding path.
