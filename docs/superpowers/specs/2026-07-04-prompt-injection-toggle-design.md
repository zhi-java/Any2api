# Prompt Injection Toggle Design

Date: 2026-07-04

## Summary

Add `ENABLE_PROMPT_INJECTION` to control only OmniAPI-authored prompt injection while keeping the existing upstream channel mode unchanged.

- `true` or unset: keep current behavior. OmniAPI may rewrite OpenAI/Anthropic requests into Web-channel prompts and inject tool-use instructions, role labels, and tool-result follow-up instructions.
- `false`/`0`/`no`/`off`: keep using the existing DeepSeek, GLM, Kimi, and Qwen Web upstream APIs, authentication, upload flows, queues, and stream parsers, but do not add OmniAPI-authored prompt text. The prompt sent to the Web upstream is the full JSON request body text captured from the client request.

This mode is **not** a switch to OpenAI-compatible or Anthropic-compatible upstream endpoints.

## Goals

1. Preserve existing behavior by default.
2. Keep all existing Web upstream integrations in both modes.
3. Disable OmniAPI-authored prompt injection when configured false.
4. In disabled mode, send the full raw client request JSON text as the Web prompt.
5. Avoid pseudo tool-call prompting and parsing in disabled mode.
6. Continue returning OpenAI-compatible responses on `/v1/chat/completions` and Anthropic-compatible responses on `/v1/messages` using existing Web stream parsers.

## Non-goals

1. Do not add or require separate standard-protocol upstream URLs/API keys.
2. Do not bypass current channel handlers.
3. Do not convert disabled mode into raw HTTP response passthrough.
4. Do not reduce multi-message requests to the latest user message.
5. Do not concatenate messages with `[System]` / `[User]` labels in disabled mode.

## Data flow

### Enabled mode

```text
Client OpenAI/Anthropic request
  -> OmniAPI route/model selection
  -> existing channel handler
  -> existing prompt builder/injection logic
  -> existing Web upstream API
  -> existing stream parser/response adapter
  -> OpenAI/Anthropic-compatible response
```

### Disabled mode

```text
Client OpenAI/Anthropic request
  -> capture full raw JSON request text
  -> OmniAPI route/model selection
  -> existing channel handler
  -> use raw JSON text as the Web prompt
  -> existing Web upstream API
  -> existing stream parser/response adapter
  -> OpenAI/Anthropic-compatible response
```

In disabled mode, OmniAPI sets tools/tool choice handling to disabled so it does not ask the model to emit OmniAPI pseudo tool-call JSON/XML and does not parse model text into protocol-level tool calls.

## Channel notes

- DeepSeek: `fullPrompt` and `latestPrompt` both use the raw JSON request text when disabled, including under conversation affinity.
- GLM: disabled mode sends one GLM user message whose text content is the raw JSON request text.
- Kimi: disabled mode passes the raw JSON request text as the prompt override while keeping Kimi Web transport behavior such as long-prompt text-file upload.
- Qwen: disabled mode sends one Qwen user message whose content is the raw JSON request text.

## Configuration

```env
# Prompt injection switch (optional, default true)
# true/unset: current Web-channel compatibility prompts.
# false/0/no/off: keep current Web upstreams, but send the full JSON request body text as the Web prompt without OmniAPI-authored prompt injection.
ENABLE_PROMPT_INJECTION=true
```

## Acceptance criteria

1. Unset/true mode behaves like the current implementation.
2. False mode does not require any separate standard-upstream URL or API-key configuration.
3. False mode still uses existing channel handlers and Web upstream APIs.
4. False mode upstream prompt is the full JSON request body text captured before model normalization.
5. False mode does not inject `[System]`, `[User]`, `[Tool result instruction]`, `assistant_response`, or generated tool instructions unless those exact strings are already present in the client JSON.
6. False mode does not synthesize protocol tool calls from model text.
