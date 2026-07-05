# Qwen Configuration Documentation Design

Date: 2026-07-05

## Goal

Make Qwen channel configuration discoverable for operators without changing runtime behavior. The project already supports Qwen credential pools and Qwen-specific queue/rate-limit settings through environment variables, but the sample environment file and README do not document them clearly.

## Scope

In scope:

- Add a Qwen section to `.env.example`.
- Document Qwen token and account-password authentication.
- Document Qwen-specific queue, concurrency, cooldown, and error-threshold settings.
- Document current behavior when Qwen credentials are missing.
- Document current base model IDs and common mode suffix examples.

Out of scope:

- Changing Qwen token/account loading behavior.
- Adding new Qwen models or mode suffixes.
- Changing queue, cooldown, rate-limit, or failure handling logic.
- Changing admin UI behavior.
- Adding real credentials, passwords, or tokens.

## Existing Behavior

The current Qwen implementation reads these authentication variables:

- `QWEN_ACCOUNTS`: comma-separated account-password entries in `email:password,email:password` format. The code logs in to obtain or refresh tokens.
- `QWEN_TOKENS`: comma-separated bearer token entries. Tokens are added to the same Qwen credential pool.

The current Qwen implementation reads these Qwen-specific tuning variables:

- `QWEN_MAX_CONCURRENT_PER_TOKEN`: per-token/account concurrency. Falls back to `MAX_CONCURRENT_PER_TOKEN`, then `1`.
- `QWEN_MAX_QUEUE_SIZE`: maximum queued Qwen requests. Falls back to `MAX_QUEUE_SIZE`, then `100`.
- `QWEN_QUEUE_TIMEOUT_MS`: queued request timeout. Falls back to `QUEUE_TIMEOUT_MS`, then `30000`.
- `QWEN_ACCOUNT_MIN_INTERVAL_MS`: minimum interval between requests for the same account. Falls back to `ACCOUNT_MIN_INTERVAL_MS`, then `1200`.
- `QWEN_RATE_LIMIT_BASE_COOLDOWN_MS`: initial cooldown after rate-limit/auth errors. Falls back to `RATE_LIMIT_BASE_COOLDOWN_MS`, then `600000`.
- `QWEN_RATE_LIMIT_MAX_COOLDOWN_MS`: maximum exponential cooldown. Falls back to `RATE_LIMIT_MAX_COOLDOWN_MS`, then `3600000`.
- `QWEN_MAX_TOKEN_ERRORS`: consecutive error threshold before an entry is unavailable. Falls back to `MAX_TOKEN_ERRORS`, then `3`.

If no Qwen credentials are configured, the Qwen token manager logs a warning and Qwen requests return a 503-style upstream availability error.

Current public Qwen base models:

- `qwen3.7-plus`
- `qwen3.7-max`
- `qwen3.6-plus`

Common routable mode suffixes include:

- `-thinking`
- `-search`
- `-deep-research`
- `-image`
- `-video`

## Proposed Documentation Changes

### `.env.example`

Add a Qwen section near the other channel credentials:

```env
# Qwen 认证（可选，使用 Qwen 渠道时必填）
# 多个 bearer token，逗号分隔
# QWEN_TOKENS=
# 账号登录，格式：email:password,email:password（自动登录获取/刷新 token）
# QWEN_ACCOUNTS=

# Qwen 队列/并发调优（可选，未设置时使用通用项或默认值）
# QWEN_MAX_CONCURRENT_PER_TOKEN=1
# QWEN_MAX_QUEUE_SIZE=100
# QWEN_QUEUE_TIMEOUT_MS=30000
# QWEN_ACCOUNT_MIN_INTERVAL_MS=1200
# QWEN_RATE_LIMIT_BASE_COOLDOWN_MS=600000
# QWEN_RATE_LIMIT_MAX_COOLDOWN_MS=3600000
# QWEN_MAX_TOKEN_ERRORS=3
```

This mirrors the existing style used by other channel sections. Values remain commented or blank so no secret is committed.

### README

Add a concise Qwen configuration subsection that explains:

1. Set `QWEN_TOKENS` for one or more bearer tokens separated by commas.
2. Set `QWEN_ACCOUNTS` for account-password login entries in `email:password,email:password` format.
3. Tokens and accounts are both loaded into the Qwen credential pool when present.
4. If no Qwen credential is configured, Qwen requests are unavailable and return an upstream availability error.
5. Qwen-specific tuning variables override generic fallback variables.
6. Base model IDs include `qwen3.7-plus`, `qwen3.7-max`, and `qwen3.6-plus`.
7. Common mode suffixes include `-thinking`, `-search`, `-deep-research`, `-image`, and `-video`.

## Error Handling

No runtime error behavior changes. Documentation will describe current behavior only:

- Missing credentials: Qwen channel remains unconfigured and requests return an availability error.
- Expired tokens without an account password: the token entry becomes unavailable.
- Repeated errors: entries become unavailable after the configured error threshold.
- Rate limiting: cooldown uses the existing base/max cooldown settings.
- Queue saturation or timeout: existing queue errors are returned.

## Testing and Verification

Because this is documentation/config-sample work only:

- No automated runtime tests are required.
- Verify `.env.example` contains the Qwen variables with no real token, account, or password values.
- Verify README mentions Qwen authentication, tuning variables, base models, and common suffixes.
- Optionally run the test suite if runtime code is touched; the intended implementation should not touch runtime code.

## Risks

- The main risk is accidentally committing real Qwen account credentials or tokens. The implementation must only add empty/commented examples.
- Another risk is documenting behavior that differs from code. The documented variables must match `src/channels/qwen/auth.js`, `src/channels/qwen/config.js`, and `src/channels/qwen/models.js` exactly.

## Implementation Boundary

The implementation should be limited to `.env.example` and README documentation updates. Runtime source files should remain unchanged unless a mismatch is discovered during implementation and explicitly approved separately.
