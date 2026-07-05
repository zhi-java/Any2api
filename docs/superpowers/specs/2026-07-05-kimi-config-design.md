# Kimi Configuration Documentation Design

Date: 2026-07-05

## Goal

Make Kimi channel configuration discoverable for operators without changing runtime behavior. The project already supports Kimi tokens and a long-input attachment threshold through environment variables, but the sample environment file and README do not document them clearly.

## Scope

In scope:

- Add a Kimi section to `.env.example`.
- Document single-token and multi-token Kimi authentication.
- Document the long-text attachment threshold.
- Document available Kimi model IDs.
- Mention the current behavior when Kimi credentials are missing.

Out of scope:

- Changing Kimi token loading behavior.
- Adding account-password login for Kimi.
- Adding new Kimi model aliases or scenarios.
- Changing admin UI behavior.
- Adding real credentials or secrets.

## Existing Behavior

The current Kimi implementation already reads these environment variables:

- `KIMI_AUTH_TOKEN`: one Kimi bearer token.
- `KIMI_AUTH_TOKENS`: comma-separated Kimi bearer token pool. This takes precedence over `KIMI_AUTH_TOKEN`.
- `KIMI_TEXT_ATTACHMENT_THRESHOLD_BYTES`: byte threshold above which a long prompt is uploaded as a text attachment. The default is `450000` bytes.

If no Kimi token is configured, the Kimi token manager logs a warning and Kimi requests return a 503-style upstream availability error.

Current public Kimi models:

- `kimi-k2.6`
- `kimi-k2.6-thinking`

## Proposed Documentation Changes

### `.env.example`

Add a Kimi section near the other channel credentials:

```env
# Kimi 认证（可选，使用 Kimi 渠道时必填）
# 单个 token
# KIMI_AUTH_TOKEN=
# 多个 token，逗号分隔（优先于 KIMI_AUTH_TOKEN）
# KIMI_AUTH_TOKENS=
# 长文本自动作为 txt 附件上传的阈值（字节，默认 450000）
# KIMI_TEXT_ATTACHMENT_THRESHOLD_BYTES=450000
```

This mirrors the existing style used by the DeepSeek and GLM sections: comments explain purpose and default behavior, while values remain blank or commented so no secret is committed.

### README

Add a concise Kimi configuration subsection that explains:

1. Set `KIMI_AUTH_TOKEN` for one token.
2. Set `KIMI_AUTH_TOKENS` for multiple tokens separated by commas.
3. `KIMI_AUTH_TOKENS` is preferred when both are set.
4. If neither is configured, Kimi requests are unavailable and return an error.
5. Available model IDs are `kimi-k2.6` and `kimi-k2.6-thinking`.
6. Large prompts above `KIMI_TEXT_ATTACHMENT_THRESHOLD_BYTES` are uploaded as txt attachments automatically.

## Error Handling

No runtime error behavior changes. Documentation will describe current behavior only:

- Missing credentials: Kimi channel remains unconfigured and returns an availability error.
- Expired tokens: existing token manager excludes expired JWT tokens.
- Failed upstream/file upload calls: existing logic records token failure and returns an upstream error.

## Testing and Verification

Because this is documentation/config-sample work only:

- No automated runtime tests are required.
- Verify `.env.example` contains the Kimi variables with no real token values.
- Verify README mentions both available Kimi model IDs and the multi-token precedence rule.
- Optionally run the test suite if nearby code is touched; the intended implementation should not touch runtime code.

## Risks

- The main risk is accidentally committing a real Kimi token. The implementation must only add empty/commented examples.
- Another risk is documenting behavior that differs from code. The documented variables must match `src/channels/kimi/auth.js` and `src/channels/kimi/client.js` exactly.

## Implementation Boundary

The implementation should be limited to `.env.example` and README documentation updates. Runtime source files should remain unchanged unless a mismatch is discovered during implementation and explicitly approved separately.
