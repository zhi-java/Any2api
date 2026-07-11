# OmniAPI Desktop IA Map (S4)

Maps current Admin SPA routes to the locked desktop information architecture.

| Desktop nav | Admin SPA today | Action |
|-------------|-----------------|--------|
| 首页 `home` | `#dashboard` | Done (S4 home rewrite) |
| 渠道 `channels` | `#channels` | Keep; present as soft cards |
| 凭据 `credentials` | `#credentials` | Keep |
| 监控 `monitor` | `#performance` | Rename label already → 监控 |
| 日志 `logs` | `#logs` | Keep |
| 设置 `settings` | `#settings` + `#apiKeys` | Merge API Keys into settings section for desktop |

## User journeys (v1)

### J1 First run
Install → Wizard → credential → test → copy endpoint → Home

### J2 Daily use
Tray status → open panel / copy endpoint → optional logs if error

### J3 Add channel later
Home checklist or Channels → Credentials → Test → back Home

### J4 Degraded channel
Tray yellow / Home「需关注」→ Channels → Credentials refresh → retest

## Implementation slices (engineering)

1. **Electron shell + tray + spawn Core**
2. **Wire real health into prototype Home/Tray**
3. **Wizard persistence** (`onboarding.completed`)
4. **Secure token display policy** (prefix only)
5. **Snippet export** (Cursor / curl)

Prototype for UX sign-off: `docs/desktop-prototype-s4.html`  
Spec: `docs/desktop-product-design-s4.md`
