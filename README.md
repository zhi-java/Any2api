# zhi2Api

Multi-channel Web-to-API proxy with OpenAI and Claude-compatible endpoints.

Version: 1.0.0

## Endpoints

- `POST /v1/chat/completions`
- `POST /v1/messages`
- `POST /v1/responses`
- `GET /v1/models`

## Run

```bash
npm install
npm start
```

## Responses API

`POST /v1/responses` is implemented as a peer protocol over Any2api's Internal Event layer. It does not bridge through `/v1/chat/completions`.

Supported first-stage inputs include:

- `input: "text"`
- `input: [{ "role": "user", "content": "text" }]`
- typed message items with `input_text`

Both streaming (`stream: true`) and non-streaming (`stream: false` or omitted) responses are supported for channels that have Internal Event runners.

## Qwen configuration

Qwen supports both bearer-token and account-password credential pools:

- `QWEN_TOKENS`: one or more bearer tokens separated by commas.
- `QWEN_ACCOUNTS`: account login entries in `email:password,email:password` format. The service logs in to obtain or refresh tokens.

When both variables are set, tokens and accounts are loaded into the same Qwen credential pool. If no Qwen credential is configured, Qwen requests are unavailable and return an upstream availability error.

Qwen-specific tuning variables override the generic fallback variables when set:

- `QWEN_MAX_CONCURRENT_PER_TOKEN`
- `QWEN_MAX_QUEUE_SIZE`
- `QWEN_QUEUE_TIMEOUT_MS`
- `QWEN_ACCOUNT_MIN_INTERVAL_MS`
- `QWEN_RATE_LIMIT_BASE_COOLDOWN_MS`
- `QWEN_RATE_LIMIT_MAX_COOLDOWN_MS`
- `QWEN_MAX_TOKEN_ERRORS`

Current Qwen base model IDs include `qwen3.7-plus`, `qwen3.7-max`, and `qwen3.6-plus`. Common routable mode suffixes include `-thinking`, `-search`, `-deep-research`, `-image`, and `-video`.

## Kimi configuration

Kimi uses bearer tokens from environment variables:

- `KIMI_AUTH_TOKEN`: a single Kimi token.
- `KIMI_AUTH_TOKENS`: comma-separated token pool. When both are set, this takes precedence over `KIMI_AUTH_TOKEN`.
- `KIMI_TEXT_ATTACHMENT_THRESHOLD_BYTES`: byte threshold for uploading long prompts as txt attachments. Default: `450000`.

If no Kimi token is configured, Kimi requests are unavailable and return an upstream availability error. Current Kimi model IDs are `kimi-k2.6` and `kimi-k2.6-thinking`.

## Prompt injection

`ENABLE_PROMPT_INJECTION` controls whether Any2api adds its own compatibility prompt text before sending requests to the existing Web upstream channels.

- `true` or unset: keep the existing DeepSeek/GLM/Kimi/Qwen Web upstreams. Any2api may convert `messages`, `tools`, `tool_choice`, and tool results into upstream-specific prompts. Tool use is requested with a per-request dynamic trigger plus strict `<function_calls>` XML. Plain answers should be normal text.
- `false`/`0`/`no`/`off`: keep using the same Web upstreams, authentication, uploads, queues, and stream parsers, but do not add Any2api-authored role labels, tool instructions, or tool-result follow-up instructions. The Web upstream prompt is the full JSON request body text captured from the client request, and model output is not parsed into protocol-level tool calls.

Old JSON pseudo-tool output such as `{"assistant_response": ..., "tool_calls": [...]}` is no longer converted into protocol tool calls in strict XML mode.

When prompt injection is disabled, multiple OpenAI or Anthropic messages are not reduced to the latest user message and are not concatenated with `[System]` / `[User]` labels. Put any system, history, tool, or other context you want the upstream model to see into the JSON request sent by the client.
