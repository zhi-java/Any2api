# Admin One-Screen Workbench Design

Date: 2026-07-11  
Status: Approved for implementation planning  
Scope: Admin dashboard, channels, credentials, API Keys, settings  
Baseline viewport: 1180×760 (Tauri desktop default)

## Goal

Refit the Admin UI into a compact one-screen workbench. Each major page should fit the 1180×760 desktop shell as much as practical. When data exceeds available space, scrolling should be constrained to table/content regions rather than making the whole page long.

This design preserves the current S4 Soft Product style and existing API surface. It changes view structure and CSS only, except for fixing duplicate copy notifications.

## Non-goals

- No new backend API endpoints.
- No modal/drawer-first redesign.
- No dark mode work.
- No change to desktop shell behavior.
- No change to channel credential data model.

## Shared Layout Rules

Add compact layout utilities under the existing Admin CSS system:

- `.compact-page`: page container optimized for 1180×760.
- `.compact-grid`: reduced-gap grid for dense dashboard cards.
- `.compact-panel`: lower padding and tighter headers than normal panels.
- `.dense-table`: compact table row height and reduced cell padding.
- `.page-split-stack`: vertical stacked content blocks with bounded heights.
- `.settings-tabs`: tab navigation for settings groups.

Rules:

1. Prefer shorter panels over hero sections.
2. Remove full-page scroll where possible.
3. Allow bounded internal scrolling only for long lists/tables.
4. Keep actions visible without pushing content below the fold.
5. Keep the visual language consistent with S4 Soft Product: soft cards, indigo accent, clear badges, comfortable but compact spacing.

## Dashboard / Home

### Service status card

Keep the current service status card with:

- Health word.
- Endpoint display.
- Copy API address button.
- Health/degraded/queue chips.

Add supported API protocol chips inside the service status card:

- OpenAI Chat Completions: `/v1/chat/completions`
- Anthropic Messages: `/v1/messages`
- OpenAI Responses: `/v1/responses`

The chips should be compact and readable, not full callout blocks.

### Copy API address behavior

Fix duplicate error/success notifications by adding a local lock/debounce around all dashboard endpoint copy buttons.

Expected behavior:

- One click triggers one copy attempt.
- While copy is running, additional clicks are ignored.
- One toast is shown per attempt.
- On success: `已复制 API 地址`.
- On failure: one clear failure toast.

### Start using card

Keep the three steps.

Change step 3:

- Title remains: `复制 API 地址到客户端`
- Remove detail text under step 3.

### Remove blocks

Remove from dashboard:

- Request trend chart panel.
- Quick actions panel.

Keep:

- Metric cards, but compact if needed.
- Channel overview, using bounded/compact card grid.

## Channels Page

The page becomes a vertical workbench.

### Top area

Compress metrics into a single compact row.

Search/filter controls are horizontal:

- Channel select.
- Model search input.

### Content area

Replace left-right two-column layout with top-bottom layout:

1. Channel table panel.
2. Model table panel.

Both panels use `.dense-table` and bounded heights. If content exceeds height, only the panel table area scrolls.

No horizontal crowding should occur in the 1180px shell.

## Credentials Page

The credentials page keeps channel tabs but becomes more compact.

### Channel tabs

Keep current tabs for:

- DeepSeek
- GLM
- Qwen
- Kimi

Use tighter spacing so tabs do not consume excessive height.

### Active channel layout

For the active channel, use a compact two-zone layout:

- Credential list panel.
- Add credential panel.

At 1180×760 these should fit without full-page scroll where possible. If a credential list is long, the list/table region scrolls internally.

### Credential hints

Show short source hints next to the token field. Required source text:

- DeepSeek token: `Local Storage → userToken`
- GLM token: `智谱清言 Cookies → chatglm_refresh_token`
- Kimi token: `Local Storage → access_token`
- Qwen token: `Qwen Studio Cookies → token`

For account mode, keep a concise note:

- Account mode uses the upstream web login account/password.
- If captcha/risk control appears, prefer token/cookie mode.

### DeepSeek layout

DeepSeek must clearly separate:

- Existing credentials: token/account rows, compact list.
- Add credential: type switch, token/account fields, source hint, save/test actions.

The current “DeepSeek 凭据” and “添加凭据” areas should read as a single focused workbench rather than two tall independent cards.

## API Keys Page

### Structure

Replace tall hero + large panels with a compact two-column workbench:

- Left: Key list.
- Right: Create Key form.

### Key list

Use `.dense-table`.

Columns:

- Name + created time.
- Key mask.
- Status/action.

The legacy admin key row remains but is compact.

### Created key reveal

If a new key was just created, show it in a compact reveal strip above or within the create panel. It should not create a tall page.

## Settings Page

Settings becomes tabbed to avoid a long page.

Tabs:

1. 服务
2. 日志
3. 会话
4. 生成
5. 启动变量

### 服务 tab

Fields:

- `mergeThinking`
- `enablePromptInjection`
- `systemFingerprint`

### 日志 tab

Fields:

- `logDir`
- `clientDebugLog`
- `clientDebugLogDir`
- `clientDebugLogMaxChars`

### 会话 tab

Fields:

- `sessionTtlSeconds`
- `maxRequestsPerSession`
- `enableConversationAffinity`
- `conversationTtlMs`
- `maxConversations`
- `maxTurnsPerSession`

### 生成 tab

Fields:

- `enableFcErrorRetry`
- `fcErrorRetryMaxAttempts`
- `deepseek.contextFallback`
- `deepseek.proSafeInputTokens`

### 启动变量 tab

Read-only table:

- `PORT`
- `ZHI2API_ENV_PATH`
- `ZHI2API_CONFIG_PATH`
- `ZHI2API_DATA_DIR`
- `HTTP_PROXY / HTTPS_PROXY`

### Save behavior

The form can remain one logical settings form. Only visible tab fields are shown, but saving should preserve untouched config values by building the same patch structure currently used for editable fields.

The save button appears within the current tab area and does not require scrolling to the bottom of a long page.

## Error Handling

- Copy endpoint errors produce a single toast per attempted click.
- Form submission errors keep existing toast behavior.
- Channel test errors keep existing toast/modal behavior.
- Settings save errors keep existing toast behavior.

## Testing / Verification

Manual verification should cover:

1. At 1180×760, dashboard does not show request trend or quick actions.
2. Dashboard service card lists three supported protocol chips.
3. Dashboard step 3 has title only, no detail text.
4. Dashboard endpoint copy triggers at most one toast per click.
5. Channels page controls are horizontal.
6. Channels and models are stacked vertically.
7. Credentials page shows token source hints for all four channels.
8. DeepSeek credentials/add form layout fits as a compact workbench.
9. API Keys list is dense and created-key reveal does not create a long page.
10. Settings page uses tabs and avoids one long scrolling form.
11. Long lists scroll inside bounded table regions, not as full-page sprawl.

## Implementation Files

Expected files to modify:

- `src/admin/scripts/views/dashboard.js`
- `src/admin/scripts/views/channels.js`
- `src/admin/scripts/views/credentials.js`
- `src/admin/scripts/views/api-keys.js`
- `src/admin/scripts/views/settings.js`
- `src/admin/styles/components.css`
- `src/admin/styles/layout.css`
- Possibly `src/admin/styles/design-system.css` for shared compact tokens if needed.

No backend files are expected to change.
