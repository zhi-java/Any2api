# Prompt Strategy and XML Tooling Design

Date: 2026-07-05

## Summary

Refactor Any2api prompt-related behavior around a shared prompt strategy layer.

The strategy layer has two modes:

- `ENABLE_PROMPT_INJECTION=true` or unset: keep existing DeepSeek, GLM, Kimi, and Qwen Web upstream integrations, but replace Any2api's old JSON pseudo-tool prompt with a strict Toolify-style dynamic-trigger XML tool protocol.
- `ENABLE_PROMPT_INJECTION=false`/`0`/`no`/`off`: keep using the same Web upstream integrations, but do not add Any2api-authored prompt text. The Web prompt is the full raw JSON request body text captured from the client request, and Any2api does not parse model text into protocol tool calls.

This design extends `2026-07-04-prompt-injection-toggle-design.md` by defining the enabled-mode XML tool protocol and its implementation boundaries.

## Goals

1. Preserve Web upstream channel behavior: authentication, uploads, queues, model routing, conversation/session handling, and stream parsers stay in place.
2. Implement a shared prompt strategy layer used by all supported protocols and channels.
3. In enabled mode, use a strict dynamic-trigger XML tool-calling protocol instead of the old `assistant_response`/`tool_calls` JSON wrapper.
4. In enabled mode, allow normal assistant responses to be plain text without JSON wrapping.
5. In disabled mode, use the complete captured raw JSON request body text as the Web prompt.
6. In disabled mode, disable Any2api tool prompt generation and tool-call parsing entirely.
7. Cover `/v1/chat/completions`, `/v1/messages`, and `/v1/responses` across DeepSeek, GLM, Kimi, and Qwen.
8. Add tests for raw JSON disabled mode, XML prompt generation, strict XML parsing, and runner behavior.

## Non-goals

1. Do not switch to standard OpenAI-compatible or Anthropic-compatible upstream APIs.
2. Do not bypass existing channel handlers or Web transports.
3. Do not implement XML parse retry, continuation retry, or model self-correction in the first pass.
4. Do not implement full deep JSON Schema validation in the first pass.
5. Do not preserve old JSON pseudo-tool parsing as a compatibility path.
6. Do not remove every legacy JSON parser/helper in the first pass if retaining unused code lowers migration risk.
7. Do not change final OpenAI, Anthropic Messages, or Responses protocol renderers except where tests require minor adaptation.

## Architecture

Introduce a shared prompt strategy module, tentatively:

```text
src/core/prompt-strategy.js
```

The module owns prompt-injection mode selection, disabled-mode raw prompt selection, enabled-mode XML tool instructions, dynamic trigger generation, and strict XML tool-call parsing.

Conceptual flow:

```text
Client request
  -> Express raw body capture
  -> protocol request adapter
  -> Internal Request
  -> Prompt Strategy
      - disabled: raw JSON prompt + no tools
      - enabled: role/message prompt + XML tool instructions when tools are usable
  -> channel runner/client
  -> existing Web upstream API
  -> existing Web stream parser
  -> Internal Events
  -> protocol renderer
  -> OpenAI/Anthropic/Responses-compatible response
```

The channel transport layer should not own tool prompt syntax. It should only receive the prompt plan and put the prompt into each upstream's expected Web request shape.

## Prompt plan shape

The strategy layer should produce a request-local prompt plan similar to:

```js
{
  promptInjectionDisabled: boolean,
  promptText: string,
  tools: Array,
  toolChoice: string | object,
  toolCallingEnabled: boolean,
  triggerSignal: string | null,
  parseToolCalls: Function | null,
  createStreamDetector: Function | null,
}
```

The exact object shape can vary, but the implementation must keep these decisions request-local:

- whether prompt injection is disabled;
- what prompt text is sent upstream;
- whether tools are enabled;
- the trigger signal used in the prompt;
- the parser/detector configured with the same trigger signal.

## Enabled mode

Enabled mode applies when `ENABLE_PROMPT_INJECTION` is unset, empty, or not one of `false`, `0`, `no`, or `off` after trimming and lowercasing.

Enabled mode keeps existing Any2api behavior at the transport level, but changes the tool prompt protocol.

### Plain responses

When no tool call is needed, the model should answer normally in plain text.

The model should not be instructed to wrap normal answers as:

```json
{"assistant_response":"...","tool_calls":[]}
```

The response pipeline should treat non-tool XML output as ordinary text.

### Dynamic trigger

For each request that can use tools, generate a request-local trigger signal:

```text
<Function_AB1c_Start/>
```

Rules:

- Use letters and digits in the random segment.
- Prefer per-request generation over a long-lived global trigger.
- Store the trigger in the prompt plan.
- The parser must only recognize the trigger generated for that request.
- A trigger inside `<think>...</think>` does not activate tool parsing.

### XML tool prompt

When tools are available and `tool_choice` is not `none`, inject instructions that require this tool-call shape:

```xml
<Function_AB1c_Start/>
<function_calls>
  <function_call>
    <tool>tool_name</tool>
    <args_json><![CDATA[{"key":"value"}]]></args_json>
  </function_call>
</function_calls>
```

The injected instructions must state:

- the trigger signal must be on its own line;
- the trigger signal must appear only once;
- the first non-whitespace content after the trigger must be `<function_calls>`;
- multiple calls belong inside one `<function_calls>` wrapper;
- each call uses one `<function_call>` block;
- `<tool>` must exactly match a declared tool name;
- `<args_json>` must contain one JSON object;
- CDATA may be used around JSON;
- no explanation should follow `</function_calls>`;
- if no tool is needed, answer normally in plain text.

### Tool list rendering

Render tools in a compact but specific format:

```text
1. <tool name="read_file">
   Description:
   ```
   Read a file from disk.
   ```
   Parameters summary: path (string)
   Required parameters: path
   Parameter details:
   - path:
     - type: string
     - required: Yes
     - description: Absolute file path
```

The first implementation may reuse existing parameter simplification helpers, but the prompt should avoid the old JSON wrapper examples.

### Tool choice behavior

`tool_choice` remains a prompt constraint plus a post-parse validation rule.

- `none`: do not inject XML tool instructions, set `toolCallingEnabled=false`, and do not parse tool calls.
- `auto` or unset: allow plain text or XML tool calls.
- `required`: add a prompt constraint that at least one tool must be called. If the model does not produce valid XML, do not synthesize a tool call.
- specific tool: add a prompt constraint that only the named tool may be used. The parser must reject calls to other tools.

## Strict XML parsing

The parser accepts only the current request's dynamic-trigger XML protocol.

Accepted shape:

```xml
<Function_AB1c_Start/>
<function_calls>
  <function_call>
    <tool>read_file</tool>
    <args_json><![CDATA[{"path":"C:\\repo\\README.md"}]]></args_json>
  </function_call>
</function_calls>
```

Parsing rules:

1. If `toolCallingEnabled=false`, do not parse.
2. If the output lacks the current trigger, return no tool calls.
3. Ignore trigger occurrences inside `<think>...</think>`.
4. Use the last valid trigger outside `<think>`.
5. Require a complete `<function_calls>...</function_calls>` block after the trigger.
6. Each `<function_call>` must include a non-empty `<tool>`.
7. `<args_json>` may be omitted only when arguments are `{}`.
8. `<args_json>` supports CDATA and non-CDATA JSON text.
9. Parsed arguments must be a JSON object. Arrays, strings, numbers, booleans, and `null` are invalid.
10. Tool names must be in the current request's declared tools.
11. Specific `tool_choice` must match the parsed tool name.
12. Old JSON pseudo-tool output is ordinary text and is not converted into protocol tool calls.

The parser should return OpenAI-shaped internal tool calls:

```js
{
  id: 'call_...',
  type: 'function',
  function: {
    name: 'read_file',
    arguments: '{"path":"C:\\repo\\README.md"}'
  }
}
```

## Streaming detector

The streaming detector replaces the current JSON `assistant_response` extractor for tool parsing.

States:

- `detecting`: emit ordinary content while watching for the request trigger outside `<think>`.
- `tool_parsing`: stop emitting trigger-and-after content, buffer until `</function_calls>` or stream end.

Streaming behavior:

1. Content before the trigger is emitted normally.
2. Once a valid trigger is detected outside `<think>`, content from the trigger onward is buffered.
3. If a complete XML tool block is parsed, emit internal tool-call events and finish with `tool_calls`.
4. If parsing fails, do not fall back to JSON. Emit the buffered content as ordinary text or finish as `stop`, depending on the runner's existing response rules.
5. If no trigger appears, all content is normal text.
6. The detector must handle trigger text split across chunks.

If text appears before a valid tool call, that prefix becomes the assistant message content. If the prefix is empty, assistant content should be `null` or omitted according to the target protocol renderer's existing behavior.

## Disabled mode

Disabled mode applies when `ENABLE_PROMPT_INJECTION` is `false`, `0`, `no`, or `off`.

The disabled prompt is the complete raw JSON request body text captured before request normalization.

Priority:

```text
req.any2api.rawRequestJsonText
  -> req.rawBody.toString('utf8')
  -> JSON.stringify(req.body ?? {}, null, 2)
```

`buildDisabledPrompt(req)` should effectively be:

```js
return getRawJsonPromptForRequest(req);
```

Disabled mode must force:

```js
tools = []
toolChoice = 'none'
toolCallingEnabled = false
triggerSignal = null
```

The raw JSON prompt may contain client-supplied `tools`, `tool_choice`, `system`, `messages`, `input`, or `instructions` fields. They remain plain text visible to the Web model. Any2api must not transform them into its own tool protocol.

Disabled mode must not add these strings unless the client JSON already contains them:

- `[System]`
- `[User]`
- `[Assistant]`
- `[Assistant tool calls]`
- `[Tool result ...]`
- `[Tool result instruction]`
- `assistant_response`
- generated XML tool instructions
- generated dynamic trigger

If the model outputs XML or old JSON pseudo-tool text while disabled, Any2api returns it as normal assistant text.

## Channel behavior

### DeepSeek

DeepSeek has `fullPrompt`, `latestPrompt`, context fallback, conversation/session affinity, and uploads.

Disabled mode:

```js
fullPrompt = rawJsonPrompt
latestPrompt = rawJsonPrompt
getPrompt = () => rawJsonPrompt
```

Conversation affinity must not switch disabled mode back to latest-user-message extraction.

Enabled mode:

- `fullPrompt` uses the full message prompt plus XML tool instructions when tools are enabled.
- `latestPrompt` keeps the existing latest-user-message optimization, but uses the same XML tool strategy and the same request trigger.
- Tool parsing uses only the strict XML parser/detector.

Keep DeepSeek Web completion, token queue, session resolution, context fallback, stream parser, and upload behavior.

### GLM

Disabled mode sends one GLM user message:

```js
[
  {
    role: 'user',
    content: [{ type: 'text', text: rawJsonPrompt }]
  }
]
```

Enabled mode keeps GLM message conversion, but any tool instructions appended by `convertMessages()` must come from the XML prompt strategy with the same trigger used by the parser.

Keep token manager, queue/slot behavior, attachments, search mode, and stream parser.

### Kimi

Disabled mode sends the raw JSON prompt as the Kimi prompt override:

```js
prompt = rawJsonPrompt
```

Kimi's long-prompt text-file upload behavior is transport behavior and should remain enabled.

Enabled mode keeps `buildKimiMessages()`, but tool instructions must use XML and the request trigger.

Keep token management, scenario selection, thinking mode, attachments, and stream parser.

### Qwen

Disabled mode sends one Qwen user message:

```js
[{ role: 'user', content: rawJsonPrompt }]
```

Enabled mode keeps `buildQwenMessages()`, but tool instructions must use XML and the request trigger.

Keep token pool, request queue, chat mode, thinking/search/deep-research modes, attachments, and stream parser.

## Protocol compatibility

This refactor changes prompt construction and tool-call detection, not the public response protocols.

The following must remain true:

- `/v1/chat/completions` returns OpenAI-compatible responses.
- `/v1/messages` returns Anthropic Messages-compatible responses.
- `/v1/responses` returns Responses-compatible JSON/SSE events.
- Successful XML tool calls become protocol-level tool calls through Internal Events and existing renderers.
- Disabled-mode XML or JSON pseudo-tool-looking text remains assistant content, not tool calls.

## Code changes

Primary files:

- Add `src/core/prompt-strategy.js`.
- Update `src/utils/response-utils.js` to make disabled prompt raw JSON and stop routing active tool parsing through old JSON pseudo-tool helpers.
- Update `src/channels/deepseek/runner.js` to use the prompt strategy for prompts, trigger, and strict XML parsing.
- Update `src/channels/common-internal-runner.js` to use the prompt strategy and XML stream detector for GLM/Kimi/Qwen.
- Update `src/channels/glm/client.js` so `convertMessages()` can append XML tool instructions using a caller-supplied trigger.
- Update `src/channels/kimi/client.js` so `buildKimiMessages()` can append XML tool instructions using a caller-supplied trigger.
- Update `src/channels/qwen/client.js` so `buildQwenMessages()` can append XML tool instructions using a caller-supplied trigger.
- Update `.env.example` and `README.md` to document strict XML enabled mode and raw JSON disabled mode.

Legacy code may remain if not used by runners during the first pass:

- `parseVirtualToolJSON()`
- `extractAssistantResponse()`
- `createJsonContentExtractor()`

These should not be used for active strict XML tool-call conversion after the refactor.

## Testing plan

### Prompt strategy unit tests

Add `test/core/prompt-strategy.test.js` covering:

1. trigger format;
2. enabled-mode XML prompt includes tool names, descriptions, and parameter details;
3. `tool_choice=none` disables tool calling;
4. `tool_choice=required` adds a must-call constraint;
5. specific tool choice adds an only-that-tool constraint;
6. disabled mode returns full raw JSON prompt;
7. disabled mode clears tools, sets `toolChoice='none'`, and disables parsing.

### XML parser tests

Cover:

1. single tool call;
2. multiple tool calls;
3. CDATA JSON;
4. non-CDATA JSON;
5. omitted args as `{}`;
6. args that decode to non-object are rejected;
7. undeclared tools are rejected;
8. specific `tool_choice` mismatch is rejected;
9. trigger inside `<think>` is ignored;
10. last valid trigger is used;
11. output without trigger returns no tool calls;
12. old JSON `assistant_response`/`tool_calls` returns no tool calls.

### Disabled prompt tests

Update or add tests covering:

1. `buildDisabledPrompt()` returns complete raw JSON;
2. multiple messages are not joined with `\n\n`;
3. request `tools` are preserved in the raw JSON prompt text;
4. Anthropic `system` remains present in raw JSON;
5. Responses `instructions` and `input` remain present in raw JSON.

### Runner tests

DeepSeek tests:

1. disabled mode sends raw JSON as both full and latest prompt;
2. disabled mode with conversation affinity still uses raw JSON;
3. enabled mode XML tool output becomes Internal ToolCall events;
4. old JSON pseudo-tool output is plain text in strict mode.

Common runner tests for GLM/Kimi/Qwen:

1. disabled mode passes raw JSON as `disabledPrompt`;
2. enabled mode uses the same trigger in prompt and parser;
3. streaming XML tool output becomes Internal ToolCall events;
4. old JSON pseudo-tool streaming output remains text.

Protocol renderer tests should continue passing. Add one end-to-end assertion where useful:

- XML tool call Internal Events render to OpenAI `tool_calls`.
- Disabled-mode XML-looking model output renders as content.

## Migration risks

1. Models may continue emitting the old JSON pseudo-tool format. In strict XML mode this is expected to become ordinary text, not a tool call.
2. Trigger text may be split across stream chunks. The detector must buffer enough text to handle this.
3. User text may mention the trigger. Per-request random triggers and `<think>`-outside detection reduce false positives.
4. XML parsing can fail for malformed model output. First pass does not retry; it should avoid data loss by returning buffered text or stopping normally.
5. Output sanitization can remove text that looks like prompt leakage. Avoid aggressive sanitization in disabled mode because the raw JSON may intentionally contain strings such as `[System]`.

## Acceptance criteria

1. Unset/true mode uses XML tool instructions, not the old JSON `assistant_response` wrapper.
2. Unset/true mode parses valid dynamic-trigger XML into protocol tool calls.
3. Unset/true mode does not parse old JSON pseudo-tool output into tool calls.
4. False mode uses the full captured raw JSON request body text as the Web prompt.
5. False mode does not require standard upstream URLs or API keys.
6. False mode still uses DeepSeek, GLM, Kimi, and Qwen Web upstreams.
7. False mode does not inject `[System]`, `[User]`, `[Tool result instruction]`, generated XML tool instructions, or generated triggers unless they already appear in the client JSON.
8. False mode disables Any2api tool handling and tool-call parsing.
9. DeepSeek disabled mode uses raw JSON for both full and latest prompt, including conversation affinity.
10. GLM disabled mode sends one user text message containing raw JSON.
11. Kimi disabled mode sends raw JSON as the prompt override and keeps long-prompt upload behavior.
12. Qwen disabled mode sends one user message containing raw JSON.
13. `/v1/chat/completions`, `/v1/messages`, and `/v1/responses` continue returning compatible responses.
