# Toolify Parity JS Refactor Design

Date: 2026-07-05

## Summary

Extend Any2api's current dynamic-trigger XML tool-calling implementation toward full Toolify-style behavior. The current implementation already supports request-local trigger signals, strict `<function_calls>` XML prompts, raw JSON disabled mode, and strict XML parsing. This refactor adds the Toolify features that most improve tool-call success rate:

1. Toolify-style history formatting for assistant tool calls and tool results.
2. JSON Schema subset validation for parsed tool arguments.
3. Default-enabled XML parse/schema retry.
4. Truncated XML continuation retry.
5. Runner integration for DeepSeek, GLM, Kimi, and Qwen without changing Web transport behavior.

`ENABLE_PROMPT_INJECTION=false/0/no/off` remains a hard boundary: no Toolify formatting, no XML prompt injection, no parsing, and no retry. Disabled mode continues to send the full raw client JSON request body as the upstream prompt.

## Goals

1. Improve tool-call success rate to be closer to the Toolify reference implementation.
2. Keep the existing Any2api Internal Request / Internal Events architecture.
3. Keep existing DeepSeek, GLM, Kimi, and Qwen Web authentication, upload, queue, and stream parser behavior.
4. Format assistant historical tool calls as the same dynamic-trigger XML protocol used for new calls.
5. Format tool results as Toolify-style `Tool execution result` blocks with `<tool_result>`.
6. Validate parsed tool arguments against a useful JSON Schema subset.
7. Retry malformed XML, truncated XML, and schema-invalid XML by default.
8. Preserve strict raw JSON behavior when prompt injection is disabled.

## Non-goals

1. Do not switch to standard OpenAI, Anthropic, or other upstream protocol APIs.
2. Do not remove the current Internal Event renderer architecture.
3. Do not implement every JSON Schema keyword; only the subset listed below is required.
4. Do not parse old JSON pseudo-tool output as protocol tool calls.
5. Do not expose retry intermediate responses to the client.
6. Do not change public response schemas except through existing tool-call events.

## Current baseline

The previous prompt strategy work added:

- `src/core/prompt-strategy.js`
- dynamic request-local trigger generation;
- strict XML instructions;
- strict XML parser;
- stream detector;
- raw JSON disabled mode;
- runner wiring for DeepSeek/common GLM/Kimi/Qwen paths.

Remaining gaps compared with the Toolify reference:

- no JSON Schema subset validation;
- no retry on malformed XML;
- no continuation retry on truncated XML;
- historical `assistant.tool_calls` and `tool` results still use mixed Any2api labels in some channel prompt builders;
- no retry abstraction for channel runners.

## Architecture

The refactor adds three focused core modules and extends prompt strategy:

```text
Internal Request
  -> Toolify history formatting
  -> Prompt Strategy
  -> Tool Validation
  -> Tool Retry
  -> Channel Runner
  -> Web upstream
  -> Stream parser
  -> Internal Events
  -> Protocol renderer
```

### New module: `src/core/tool-validation.js`

Responsibilities:

- infer schema/value type names;
- validate argument objects against a JSON Schema subset;
- validate parsed tool calls against declared tools and `tool_choice`;
- return concise error details for retry prompts.

Supported schema keywords:

```text
type
properties
required
additionalProperties
items
enum
const
anyOf
oneOf
allOf
pattern
minLength
maxLength
```

### New module: `src/core/toolify-format.js`

Responsibilities:

- build `tool_call_id -> { name, arguments }` index from message history;
- format assistant historical tool calls as dynamic-trigger XML;
- format tool result messages as Toolify-style tool result blocks;
- preprocess enabled-mode messages before channel prompt builders flatten them.

### New module: `src/core/tool-retry.js`

Responsibilities:

- read retry configuration;
- diagnose XML parse/schema failures;
- classify failures as `no_fc`, `truncated`, `syntax_error`, or `schema_error`;
- build retry prompts;
- build continuation prompts;
- detect continuation vs full rewrite responses;
- merge continuation output;
- run the retry loop using a channel-provided retry callback.

### Extended module: `src/core/prompt-strategy.js`

Responsibilities retained:

- create request-local prompt plans;
- generate trigger;
- build XML instructions;
- parse XML;
- create stream detector.

New responsibilities:

- call `validateParsedTools()` after XML parse;
- return structured parse failures for retry;
- expose enough failure data for `tool-retry.js`;
- keep old JSON pseudo-tool output unparsed.

## Toolify-style history formatting

### Assistant historical tool calls

When prompt injection is enabled, assistant messages with tool calls should be transformed into XML using the current request trigger:

```xml
<Function_AB12_Start/>
<function_calls>
  <function_call>
    <tool>read_file</tool>
    <args_json><![CDATA[{"path":"README.md"}]]></args_json>
  </function_call>
</function_calls>
```

Rules:

- Preserve assistant text content before the XML when present.
- Use the same trigger as the current request prompt plan.
- Put all historical calls inside one `<function_calls>` wrapper.
- Use CDATA for `args_json`.
- Escape `]]>` inside CDATA as `]]]]><![CDATA[>`.
- Reject assistant tool call arguments that do not decode to a JSON object.

### Tool result messages

Tool result messages should be transformed using the referenced historical assistant tool call:

```text
Tool execution result:
- Tool name: read_file
- Tool arguments: {"path":"README.md"}
- Execution result:
<tool_result>
file content...
</tool_result>
```

Rules:

- Build an index from assistant historical tool calls before formatting tool messages.
- If a `tool_call_id` cannot be found, reject the request with a 400-style internal API error.
- If tool result content is an array or object, use existing text extraction utilities to preserve readable content.
- Do not run this formatting when prompt injection is disabled.

### Non-tool messages

Keep current role formatting for ordinary system/user/assistant messages in each channel. The parity goal here is tool-call consistency, not a full rewrite of all transcript labels.

## JSON Schema validation

After XML parsing but before returning protocol-level tool calls:

1. Validate tool name against declared tools.
2. Validate `tool_choice` constraints.
3. Validate `args_json` is a JSON object.
4. Validate the args object against the declared tool's parameter schema subset.

Example error:

```text
Tool call #1 'read_file': schema validation failed: read_file.path: expected type 'string', got 'number'
```

Validation errors should not be silently ignored. With retry enabled, they become `schema_error` and feed the retry prompt. If retry is disabled or exhausted, no protocol tool call is produced.

## Retry configuration

Add environment variables:

```env
# Function-call XML parse/schema error retry. Default true.
ENABLE_FC_ERROR_RETRY=true

# Maximum parse attempts including the original model output. Default 3.
FC_ERROR_RETRY_MAX_ATTEMPTS=3
```

Boolean false values are:

```text
false, 0, no, off
```

`FC_ERROR_RETRY_MAX_ATTEMPTS` should be clamped to a safe range, for example 1-10.

Prompt injection disabled mode always disables retry regardless of these variables.

## Failure classification

### `no_fc`

Condition:

- no current trigger outside `<think>`.

Behavior:

- no retry;
- return ordinary text.

### `truncated`

Condition:

- current trigger outside `<think>` exists;
- `<function_calls>` opening exists after the trigger;
- complete `</function_calls>` closing is missing.

Behavior:

- send continuation prompt;
- prefer continuation from the cutoff;
- allow full rewrite if the model starts again with the trigger.

### `syntax_error`

Condition:

- trigger exists;
- complete XML block exists;
- XML shape, JSON parse, trailing-text rule, or required tag structure fails.

Behavior:

- send rewrite prompt;
- require complete XML from the trigger.

### `schema_error`

Condition:

- XML structure is parseable;
- args fail JSON Schema subset validation or tool_choice validation.

Behavior:

- send rewrite prompt with schema error details.

## Retry prompts

### Rewrite prompt

Use Toolify-style wording:

```text
Your previous response attempted to make a function call but the format was invalid or could not be parsed.

Your original response:
```
...
```

Error details:
...

Instructions:
Please retry and output the function call in the correct XML format. Remember:
1. Start with the trigger signal on its own line
2. Immediately follow with the <function_calls> XML block
3. Use <args_json> with valid JSON object parameters
4. The arguments must match the declared tool schema
5. Do not add any text after </function_calls>

Please provide the corrected function call now. DO NOT OUTPUT ANYTHING ELSE.
```

### Continuation prompt

Use Toolify-style wording:

```text
Your previous response was cut off before the function call XML was complete.

Your truncated response:
```
...tail...
```

What happened:
Missing closing </function_calls> tag

Option A:
Output ONLY the exact continuation from where you were cut off.

Option B:
Only if earlier content was wrong, start fresh with the complete function call from the trigger signal.

Choose Option A unless you believe the previous output contained errors.
```

## Retry abstraction

`tool-retry.js` should not know channel internals. It receives a callback:

```js
retryToolRequest({
  retryPrompt,
  currentContent,
  messages,
  signal,
}) -> Promise<string>
```

`attemptToolParseWithRetry()` controls the loop:

1. Parse and validate current content.
2. If success, return tool calls.
3. If `no_fc`, return null without retry.
4. If retry disabled or attempts exhausted, return failure.
5. Build retry or continuation prompt.
6. Call `retryToolRequest()`.
7. For continuation response, merge with truncated content.
8. For full rewrite, replace current content.
9. Repeat.

Retry output is internal only and must not stream to the client.

## Runner integration

### DeepSeek

DeepSeek can implement `retryToolRequest()` by calling existing `completion()` internally and aggregating content from `parseSSEStream()`.

Retry prompt context:

- original enabled-mode prompt/messages;
- assistant current malformed/truncated content;
- user retry prompt;
- same trigger and tool schema instructions.

Retry must not generate a new trigger.

### Common runner for GLM/Kimi/Qwen

`runParsedStreamChannel()` should accept `retryToolRequest` from `startStream()` result:

```js
{
  streamBody,
  cleanup,
  retryToolRequest,
}
```

Each channel runner supplies its own callback:

- GLM: call `glmChatCompletion()` with retry messages, aggregate `parseGLMStream()` content.
- Kimi: call `kimiChatCompletion()` with retry prompt, aggregate `parseKimiStream()` content.
- Qwen: call `qwenChatCompletion()` with retry messages, aggregate `parseQwenStream()` content.

The common runner coordinates when to retry and how to convert success/failure into Internal Events.

## Streaming behavior

1. Before trigger: stream text normally.
2. Once trigger is detected: buffer trigger and tool XML; do not emit it yet.
3. If XML succeeds: emit tool call events and finish with `tool_calls`.
4. If XML fails and retry succeeds: emit tool call events and finish with `tool_calls`.
5. If retry fails: emit original buffered text as normal text and finish with `stop`.
6. If no trigger: no retry and normal text response.

Trigger-prefix text that was already emitted remains part of assistant content. Retry should repair only the tool XML portion.

## Disabled mode

When `ENABLE_PROMPT_INJECTION=false/0/no/off`:

- do not preprocess messages with Toolify format;
- do not generate trigger;
- do not inject XML instructions;
- do not parse tool calls;
- do not schema-validate tool calls;
- do not retry;
- send full raw client JSON as the Web prompt.

This remains a hard acceptance criterion.

## Testing plan

### `test/core/tool-validation.test.js`

Cover:

- missing required properties;
- wrong primitive types;
- enum;
- const;
- pattern;
- minLength and maxLength;
- additionalProperties false;
- array items;
- anyOf;
- oneOf;
- allOf;
- concise error message formatting.

### `test/core/toolify-format.test.js`

Cover:

- assistant tool calls become one XML block;
- multiple tool calls in one block;
- CDATA wrapping;
- `]]>` escaping;
- non-object arguments rejected;
- tool result resolved by `tool_call_id`;
- missing `tool_call_id` rejected;
- ordinary text preserved before XML.

### `test/core/tool-retry.test.js`

Cover:

- `no_fc` does not call retry callback;
- `syntax_error` builds rewrite prompt;
- `schema_error` builds rewrite prompt;
- `truncated` builds continuation prompt;
- continuation merge success;
- full rewrite success;
- retry disabled;
- max attempts respected.

### Existing tests to extend

- `test/core/prompt-strategy.test.js`: schema validation failure and structured parse result.
- `test/channels/deepseek-runner.test.js`: retry wiring/source assertions or behavior tests.
- `test/channels/prompt-strategy-wiring.test.js`: common runner accepts channel retry callbacks.
- `test/utils/response-utils.test.js`: ensure disabled raw JSON behavior remains unchanged.

Run:

```bash
node --test test/core/tool-validation.test.js
node --test test/core/toolify-format.test.js
node --test test/core/tool-retry.test.js
node --test test/core/prompt-strategy.test.js
npm test
```

## Acceptance criteria

1. Enabled-mode historical assistant tool calls are XML, not `[Assistant tool calls]`.
2. Enabled-mode tool results use `Tool execution result` and `<tool_result>`.
3. Parsed XML tool args are validated against the JSON Schema subset.
4. Schema errors trigger retry by default.
5. Malformed XML triggers rewrite retry by default.
6. Truncated XML triggers continuation retry by default.
7. Retry success produces protocol-level tool calls.
8. Retry failure emits/falls back to original buffered text without swallowing content.
9. `no_fc` normal answers do not retry.
10. Disabled prompt injection mode remains raw JSON only and does not format, parse, validate, or retry tools.
11. DeepSeek, GLM, Kimi, and Qwen continue using existing Web transports.
12. `/v1/chat/completions`, `/v1/messages`, and `/v1/responses` remain compatible.
13. Old JSON pseudo-tool output remains ordinary text.
14. `npm test` passes.
