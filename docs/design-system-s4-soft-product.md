# OmniAPI Design System — S4 Soft Product

> Status: **Adopted** (2026-07-11)  
> Product: OmniAPI admin console  
> Style: Soft Product — friendly local AI gateway, onboarding-first

## 1. Positioning

| Axis | Choice |
|------|--------|
| Tone | Calm, approachable, trustworthy |
| Density | Comfortable (not ops-dense by default) |
| Primary job | Install → configure → copy endpoint → use |
| Secondary job | Monitor health lightly; deep metrics live one level down |
| Audience | Developers installing a local gateway + light operators |

**Not the default aesthetic:** industrial dark ops (S1), compact grids (S3), terminal mono (S5). Those may appear later as optional skins; S4 is the product default.

## 2. Color tokens

### Light (default)

| Token | Value | Usage |
|-------|-------|-------|
| `--bg-canvas` | `#FAFBFF` | App background |
| `--bg-sidebar` | `#FFFFFF` | Side navigation |
| `--bg-surface` | `#FFFFFF` | Cards / panels |
| `--bg-subtle` | `#F8FAFC` | Nested wells, code boxes |
| `--bg-accent-soft` | `#EEF2FF` | Selected nav, soft chips |
| `--border-subtle` | `#E2E8F0` | Default borders |
| `--border-strong` | `#CBD5E1` | Inputs, dashed wells |
| `--border-accent` | `#C7D2FE` | Focused / active soft borders |
| `--text-primary` | `#0F172A` | Headings, primary copy |
| `--text-secondary` | `#64748B` | Subtitles, meta |
| `--text-muted` | `#94A3B8` | Hints, timestamps |
| `--accent` | `#4F46E5` | Primary CTA, active states |
| `--accent-hover` | `#4338CA` | Hover CTA |
| `--accent-soft` | `#EEF2FF` | Soft fills |
| `--success` | `#10B981` | Healthy / running |
| `--success-soft` | `#ECFDF5` | Success chips |
| `--success-border` | `#BBF7D0` | Success cards |
| `--warning` | `#F59E0B` | Degraded / cooldown |
| `--warning-soft` | `#FFFBEB` | Warning chips |
| `--warning-text` | `#C2410C` | Warning labels |
| `--danger` | `#EF4444` | Errors / stop |
| `--danger-soft` | `#FEF2F2` | Error surfaces |
| `--info` | `#6366F1` | Informational |
| `--cyan` | `#06B6D4` | Secondary metric accent (sparingly) |

### Dark (optional later)

Prefer soft charcoal, not pure black:

| Token | Value |
|-------|-------|
| `--bg-canvas` | `#0B1020` |
| `--bg-surface` | `#121A2F` |
| `--text-primary` | `#E8EEF8` |
| `--accent` | `#818CF8` |

Ship light first; dark is phase-2.

## 3. Typography

| Role | Stack | Size / weight |
|------|-------|----------------|
| Display / H1 | `Plus Jakarta Sans`, `Geist`, `Inter`, system | 26–28px / 800 |
| Title / H2 | same | 16–18px / 700 |
| Body | `Inter`, `Segoe UI`, system | 14–15px / 400 · line-height 1.55 |
| Label | same | 12px / 600 · secondary color |
| Mono / endpoint | `JetBrains Mono`, `Cascadia Code`, `SF Mono` | 13px / 500 |

Numbers in KPIs: `font-variant-numeric: tabular-nums`.

## 4. Shape & elevation

| Token | Value |
|-------|-------|
| `--radius-sm` | `10px` |
| `--radius-md` | `14px` |
| `--radius-lg` | `18px` |
| `--radius-xl` | `22px` |
| `--radius-pill` | `999px` |
| `--shadow-card` | `0 18px 40px rgba(15, 23, 42, 0.05)` |
| `--shadow-soft` | `0 10px 30px rgba(15, 23, 42, 0.04)` |
| `--space-1..6` | 4 / 8 / 12 / 16 / 24 / 32 px |

Cards: white + 1px `--border-subtle` + `--shadow-card`.  
Avoid heavy glass blur as the main language.

## 5. Components

### Buttons
- **Primary:** solid `--accent`, white text, radius 12–14px, padding 10×16
- **Secondary:** `--accent-soft` fill, `--accent` text
- **Ghost:** white / transparent + border subtle
- One primary CTA per view (e.g. “复制 API 地址”)

### Status chips
Always color **+** text (never color alone):

| State | Style |
|-------|-------|
| Healthy / Running | green soft bg + “健康/运行中” |
| Degraded | amber soft bg + “降级/需关注” |
| Unconfigured | slate subtle + “未配置” |
| Error | red soft + “错误” |

### Service switch
Large friendly toggle on home — primary mental model is **on/off**, not “deploy cluster”.

### Endpoint well
Dashed border, mono font, copy button adjacent. This is a first-class control, not a footnote.

### Nav
Soft selected state (`--bg-accent-soft` + accent text). Icons + labels. Max 5–6 top items:
`首页 · 渠道 · 监控 · 日志 · 设置` (+ optional 诊断)

## 6. Information architecture (S4-first)

### A. First-run wizard (fullscreen steps)
1. Welcome  
2. Add channel credentials (token / account)  
3. One-click model test  
4. Generate local API key + port  
5. Copy snippets (Cursor / OpenAI base URL / curl)  
6. Enter Home  

### B. Home (running state) — default window
Priority order:
1. Big service switch + status word  
2. Endpoint + **复制 API 地址**  
3. Next-step checklist (if incomplete)  
4. 4 soft KPIs (requests, success, latency, accounts)  
5. Channel summary cards (not dense tables)  

### C. Secondary
- **渠道:** friendly cards → drill into credentials  
- **监控:** simplified charts; advanced percentiles under “高级”  
- **日志 / 诊断:** progressive disclosure  
- **设置:** port, autostart, keys, theme  

Deep ops visuals (credential honeycomb, heatmaps, trace waterfall) live under **监控/诊断**, not on Home.

## 7. Motion & feedback

- Micro: 150–250ms ease-out  
- Toggle / copy success: brief checkmark or toast 3s  
- Loading: skeleton on cards, not full-page spinners when >300ms  
- Respect `prefers-reduced-motion`

## 8. Deployment surfaces

Admin 控制台同时服务于本地运行与 Docker 部署两种形态，不区分外壳：

- 本地：`npm start` 后浏览器访问 `http://localhost:3000/admin`
- Docker：容器内同样端口，由 `docker-compose.yml` 映射到宿主机
- 通知/文案使用平实语言（“GLM 渠道需关注”而非只给原始错误码）

## 9. Explicit anti-patterns (for S4)

- Dark ops dashboard as first screen  
- Statusline/terminal chrome as default  
- Dense 8-column matrices on Home  
- Multiple competing primary buttons  
- Emoji as icons (use Lucide/Heroicons SVG)  
- Raw hex sprinkled in components — use tokens only  

## 10. Implementation mapping

| Target | Action |
|--------|--------|
| `src/admin/styles/design-system.css` | Replace tokens with S4 light set |
| Admin pages | Reorder Home toward switch + endpoint + steps |
| Optional skins | S1/S5 later behind Settings → Appearance |

## 11. Reference preview

Interactive mock: [`docs/style-preview.html`](style-preview.html) → tab **S4 Soft Product**.
