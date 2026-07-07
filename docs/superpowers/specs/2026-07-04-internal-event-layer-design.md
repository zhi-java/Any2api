# Internal Event Layer Design

Date: 2026-07-04

## Summary

Introduce a long-term protocol-neutral architecture for OmniAPI before rebuilding prompt injection and adding `/v1/responses` support.

The central change is to stop treating OpenAI Chat Completions as the internal canonical protocol. Instead, every external protocol is adapted into an OmniAPI-owned **Internal Request** representation, every channel emits an OmniAPI-owned **Internal Event** stream, and every client protocol is rendered from that event stream.

```text
Client protocol
  ├─ POST /v1/chat/completions
  ├─ POST /v1/messages
  └─ POST /v1/responses
        ↓
Protocol Request Adapter
        ↓
Internal Request
        ↓
Model Router / Channel Resolver
        ↓
Prompt Strategy / Channel Request Builder
        ↓
Channel Runner
        ↓
Internal Event Stream
        ↓
Protocol Response Renderer
  ├─ Chat Completions Renderer
  ├─ Claude Messages Renderer
  └─ Responses Renderer
        ↓
Client protocol output
```

This design makes Chat Completions, Claude Messages, and Responses peer protocols. `/v1/responses` must not be implemented as `Responses -> Chat Completions -> Responses` for the long-term architecture.

## Goals

1. Add a stable internal architecture for future protocol and channel expansion.
2. Make `/v1/chat/completions`, `/v1/messages`, and `/v1/responses` peer protocol adapters.
3. Define a protocol-neutral Internal Request schema.
4. Define a protocol-neutral Internal Event stream.
5. Move protocol-specific output construction into renderers.
6. Move channel-specific upstream behavior into channel runners.
7. Provide a clean integration point for the upcoming prompt-injection refactor.
8. Support staged migration so existing DeepSeek, GLM, Kimi, and Qwen behavior can be preserved while the architecture changes.

## Non-goals

1. Do not implement `/v1/responses` by internally calling `/v1/chat/completions`.
2. Do not rewrite every channel in one step.
3. Do not redesign the prompt-injection strategy in this spec.
4. Do not require upstream channels to support native OpenAI, Claude, or Responses APIs.
5. Do not remove the existing Web upstream integrations, token pools, queues, uploads, or stream parsers.
6. Do not promise full OpenAI Responses API parity in the first implementation. The architecture must allow it, but support can be incremental.

## Current problems this addresses

Current protocol and channel responsibilities are tangled:

- `src/routes/api.js` routes directly to channel handlers for Chat Completions and Claude Messages.
- Channel handlers build prompts, call upstream Web APIs, parse upstream streams, and write client protocol responses.
- `src/utils/openai-response.js` and `src/utils/claude-response.js` are response builders today, but channels still control too much of the streaming response flow.
- Prompt injection, pseudo tool-call prompting, tool-call parsing, and output sanitization are intertwined with response utilities and channel handlers.
- Adding `/v1/responses` by bridging through Chat Completions would preserve the current coupling and make future Responses features hard to support correctly.

The new design introduces explicit boundaries so protocol adapters, prompt strategy, channel execution, and response rendering can evolve independently.

## Architecture layers

### 1. Protocol request adapters

Protocol request adapters convert external request bodies into Internal Request objects.

Suggested files:

```text
src/protocols/chat-completions/request-adapter.js
src/protocols/claude-messages/request-adapter.js
src/protocols/responses/request-adapter.js
```

Responsibilities:

- Validate protocol-specific required fields.
- Normalize request fields into Internal Request.
- Preserve raw request metadata for logging, disabled prompt injection mode, and debugging.
- Convert protocol-specific tool definitions into the internal tool schema.
- Convert protocol-specific input/message structures into internal messages.

They must not:

- Call upstream channels.
- Build channel prompts.
- Write HTTP responses.
- Emit SSE events.

### 2. Internal Request

Internal Request is OmniAPI's canonical input representation. It must not mirror any single external API.

Initial shape:

```js
{
  id: "req_xxx",

  protocol: "chat_completions" | "claude_messages" | "responses",

  model: {
    requested: "qwen3-coder-plus",
    normalized: "qwen3-coder-plus",
    channel: "qwen"
  },

  stream: true,

  messages: [
    {
      role: "system" | "developer" | "user" | "assistant" | "tool",
      content: [
        { type: "text", text: "..." },
        { type: "image", source: {} },
        { type: "file", source: {} }
      ],
      toolCalls: [],
      toolResult: null,
      metadata: {}
    }
  ],

  instructions: {
    system: "...",
    developer: "..."
  },

  tools: [
    {
      type: "function",
      name: "Read",
      description: "Read a file",
      parameters: {}
    }
  ],

  toolChoice: {
    mode: "auto" | "none" | "required" | "specific",
    name: "optional_tool_name"
  },

  generation: {
    maxTokens: 2048,
    temperature: undefined,
    topP: undefined,
    reasoning: {
      enabled: true,
      effort: undefined
    }
  },

  responseFormat: {
    type: "text" | "json_object" | "json_schema",
    jsonSchema: null
  },

  conversation: {
    id: null,
    previousResponseId: null,
    parentMessageId: null
  },

  raw: {
    body: {},
    rawJsonText: "..."
  },

  metadata: {}
}
```

The exact object can be refined during implementation, but these concepts must remain separate:

- external protocol identity,
- normalized model/channel identity,
- internal messages,
- instructions,
- tools,
- tool choice,
- generation options,
- conversation identity,
- raw request metadata.

### 3. Model router / channel resolver

The model router maps `internalRequest.model.requested` to:

- normalized upstream model name,
- channel key,
- channel-specific model config.

This layer should remain protocol-neutral. It should not care whether the request came from Chat Completions, Claude Messages, or Responses.

### 4. Prompt strategy / channel request builder

This layer converts Internal Request into a channel-specific upstream request plan.

This is where the future prompt-injection refactor belongs.

Future prompt plan shape:

```js
{
  strategy: "legacy" | "raw-json" | "tool-json" | "native-like",
  channel: "qwen",
  messages: [],
  prompt: "...",
  injectedInstructions: "...",
  toolProtocol: {
    mode: "json-wrapper" | "xml" | "native" | "none",
    parser: "virtual-tool-json"
  },
  uploads: []
}
```

This design intentionally keeps prompt strategy out of protocol renderers. A Responses renderer should not know how prompts are injected into Qwen Web, and a channel runner should not know how to write Responses SSE events.

### 5. Channel runners

A channel runner executes a request against one upstream channel and yields Internal Events.

Suggested files:

```text
src/channels/deepseek/runner.js
src/channels/glm/runner.js
src/channels/kimi/runner.js
src/channels/qwen/runner.js
```

Interface:

```js
async function* runChannel(internalRequest, context) {
  yield { type: "run.started", ... };
  yield { type: "message.started", ... };
  yield { type: "content.text.delta", delta: "..." };
  yield { type: "run.completed", finishReason: "stop", usage: {} };
}
```

Channel runner responsibilities:

- Render the channel request plan into upstream Web API calls.
- Handle channel authentication, token selection, queues, and session affinity.
- Handle uploads and channel-specific attachment conversion.
- Parse upstream streaming responses.
- Convert upstream chunks into Internal Events.
- Surface channel errors as `run.failed` or thrown errors according to the generation core contract.

Channel runners must not:

- Write Express responses.
- Emit OpenAI Chat Completions SSE directly.
- Emit Claude Messages SSE directly.
- Emit Responses SSE directly.
- Decide protocol-specific response object shape.

### 6. Internal Event stream

Internal Events are the canonical output representation from channels.

Initial event set:

```text
run.started
message.started
content.text.delta
content.text.done
reasoning.delta
reasoning.done
tool_call.started
tool_call.arguments.delta
tool_call.done
message.done
usage.updated
run.completed
run.failed
```

#### Common fields

Most events should carry:

```js
{
  type: "content.text.delta",
  requestId: "req_xxx",
  responseId: "gen_xxx",
  messageId: "msg_xxx",
  outputIndex: 0,
  contentIndex: 0,
  timestamp: 1234567890,
  raw: null
}
```

`raw` is optional and should be used for diagnostics only. Renderers must not depend on raw upstream event shapes.

#### Text events

```js
{
  type: "content.text.delta",
  requestId: "req_xxx",
  responseId: "gen_xxx",
  messageId: "msg_xxx",
  outputIndex: 0,
  contentIndex: 0,
  delta: "你好"
}
```

```js
{
  type: "content.text.done",
  requestId: "req_xxx",
  responseId: "gen_xxx",
  messageId: "msg_xxx",
  outputIndex: 0,
  contentIndex: 0,
  text: "你好"
}
```

#### Reasoning events

```js
{
  type: "reasoning.delta",
  requestId: "req_xxx",
  responseId: "gen_xxx",
  messageId: "msg_xxx",
  delta: "..."
}
```

Reasoning exposure is renderer-specific. A renderer may expose, suppress, or aggregate reasoning according to the target protocol and project configuration.

#### Tool call events

```js
{
  type: "tool_call.started",
  requestId: "req_xxx",
  responseId: "gen_xxx",
  messageId: "msg_xxx",
  toolCallId: "call_xxx",
  index: 0,
  name: "Read",
  arguments: ""
}
```

```js
{
  type: "tool_call.arguments.delta",
  requestId: "req_xxx",
  responseId: "gen_xxx",
  messageId: "msg_xxx",
  toolCallId: "call_xxx",
  index: 0,
  delta: "{\"file_path\":"
}
```

```js
{
  type: "tool_call.done",
  requestId: "req_xxx",
  responseId: "gen_xxx",
  messageId: "msg_xxx",
  toolCallId: "call_xxx",
  index: 0,
  name: "Read",
  arguments: "{\"file_path\":\"D:\\\\tools\\\\OmniAPI\\\\README.md\"}"
}
```

#### Completion event

```js
{
  type: "run.completed",
  requestId: "req_xxx",
  responseId: "gen_xxx",
  finishReason: "stop" | "tool_calls" | "length" | "error",
  usage: {
    inputTokens: 0,
    outputTokens: 0,
    reasoningTokens: 0,
    totalTokens: 0
  }
}
```

### 7. Protocol response renderers

Renderers consume Internal Events and produce protocol-specific HTTP responses.

Suggested files:

```text
src/protocols/chat-completions/renderer.js
src/protocols/claude-messages/renderer.js
src/protocols/responses/renderer.js
```

Renderer responsibilities:

- Set HTTP status and headers.
- Convert Internal Events into protocol-specific SSE events for streaming requests.
- Aggregate Internal Events into protocol-specific JSON objects for non-streaming requests.
- Map internal finish reasons to protocol finish/stop reasons.
- Map internal tool-call events to protocol-specific tool-call structures.
- Map internal usage fields to protocol-specific usage fields.

Renderers must not:

- Call channels.
- Build prompts.
- Know upstream Web API details.
- Know channel token or queue details.

## Protocol behavior

### Chat Completions protocol

Request adapter:

- `messages` -> `internal.messages`
- `tools` -> `internal.tools`
- `tool_choice` -> `internal.toolChoice`
- `stream` -> `internal.stream`
- `max_tokens`, `temperature`, `top_p` -> `internal.generation`

Streaming renderer maps Internal Events to Chat Completions chunks:

```text
run.started          -> initial chat.completion.chunk with assistant role
content.text.delta   -> delta.content
reasoning.delta      -> delta.reasoning_content if enabled for Chat renderer
tool_call.*          -> delta.tool_calls
run.completed        -> final chunk with finish_reason + data: [DONE]
```

Non-streaming renderer aggregates to:

```js
{
  id: "chatcmpl_xxx",
  object: "chat.completion",
  created: 1234567890,
  model: "...",
  choices: [
    {
      index: 0,
      message: {
        role: "assistant",
        content: "...",
        tool_calls: []
      },
      finish_reason: "stop"
    }
  ],
  usage: {}
}
```

### Claude Messages protocol

Request adapter:

- `system` -> `internal.instructions.system`
- `messages` -> `internal.messages`
- `tools` -> `internal.tools`
- `tool_choice` -> `internal.toolChoice`
- `thinking` -> `internal.generation.reasoning`

Streaming renderer maps Internal Events to Claude events:

```text
run.started          -> message_start
message.started      -> content_block_start
content.text.delta   -> content_block_delta
tool_call.started    -> content_block_start with tool_use
tool_call.arguments.delta -> input_json_delta
tool_call.done       -> content_block_stop
run.completed        -> message_delta + message_stop
```

Non-streaming renderer aggregates to the Claude Messages response object.

### Responses protocol

Request adapter must support at least:

```js
{
  model: "...",
  input: "hello",
  stream: true
}
```

```js
{
  model: "...",
  input: [
    { role: "user", content: "hello" }
  ]
}
```

```js
{
  model: "...",
  input: [
    {
      type: "message",
      role: "user",
      content: [
        { type: "input_text", text: "hello" }
      ]
    }
  ]
}
```

Mapping:

- `instructions` -> `internal.instructions.system` or developer instruction according to implementation policy.
- `input` -> `internal.messages`.
- `tools` -> `internal.tools`.
- `tool_choice` -> `internal.toolChoice`.
- `previous_response_id` -> `internal.conversation.previousResponseId`.
- `stream` -> `internal.stream`.

Streaming renderer maps Internal Events to Responses events:

```text
run.started          -> response.created
message.started      -> response.output_item.added + response.content_part.added
content.text.delta   -> response.output_text.delta
content.text.done    -> response.output_text.done + response.content_part.done
message.done         -> response.output_item.done
tool_call.*          -> response.output_item.* / response.function_call_arguments.* events
run.completed        -> response.completed
run.failed           -> response.failed
```

Initial text streaming sequence:

```text
event: response.created
data: {...}

event: response.output_item.added
data: {...}

event: response.content_part.added
data: {...}

event: response.output_text.delta
data: {"delta":"你"}

event: response.output_text.done
data: {...}

event: response.completed
data: {...}
```

Non-streaming Responses output should aggregate to:

```js
{
  id: "resp_xxx",
  object: "response",
  created_at: 1234567890,
  status: "completed",
  model: "...",
  output: [
    {
      id: "msg_xxx",
      type: "message",
      status: "completed",
      role: "assistant",
      content: [
        {
          type: "output_text",
          text: "...",
          annotations: []
        }
      ]
    }
  ],
  output_text: "...",
  usage: {
    input_tokens: 0,
    output_tokens: 0,
    total_tokens: 0
  }
}
```

## Generation core

Add a protocol-neutral generation orchestrator.

Suggested file:

```text
src/core/generation.js
```

Responsibilities:

1. Accept Internal Request.
2. Resolve model/channel.
3. Build channel request plan.
4. Invoke the selected channel runner.
5. Normalize runner errors into Internal Events or throw protocol-neutral errors.
6. Return an async iterable of Internal Events.

Sketch:

```js
export async function* generateInternalEvents(internalRequest, context) {
  const resolved = resolveModelAndChannel(internalRequest.model.requested);
  const requestWithModel = applyResolvedModel(internalRequest, resolved);
  const channelRunner = getChannelRunner(resolved.channel);

  yield* channelRunner(requestWithModel, context);
}
```

Routes should become thin:

```text
route receives HTTP request
  -> protocol request adapter
  -> generateInternalEvents
  -> protocol renderer
```

## Migration strategy

Use staged migration to avoid destabilizing the existing service.

### Phase 1: Add core types and renderer skeletons

Add:

```text
src/core/internal-request.js
src/core/internal-events.js
src/core/generation.js
src/protocols/chat-completions/request-adapter.js
src/protocols/chat-completions/renderer.js
src/protocols/claude-messages/request-adapter.js
src/protocols/claude-messages/renderer.js
src/protocols/responses/request-adapter.js
src/protocols/responses/renderer.js
```

Acceptance:

- No existing endpoint behavior changes yet.
- Internal schemas and helpers have focused unit tests.
- Responses renderer can render a synthetic Internal Event stream.

### Phase 2: Build one channel runner as a reference implementation

Start with DeepSeek because it exposes the important boundary problems: prompt building, session affinity, thinking, uploads, stream parsing, and tool-call parsing.

Acceptance:

- DeepSeek `/v1/chat/completions` can run through Internal Events and the Chat renderer.
- Existing DeepSeek behavior remains compatible for common text streaming.
- Existing DeepSeek non-streaming behavior remains compatible where currently supported.

### Phase 3: Add `/v1/responses` on top of Internal Events

Implement:

```text
Responses request adapter
  -> Internal Request
  -> generation core
  -> Responses renderer
```

Acceptance:

- `POST /v1/responses` accepts string input.
- `POST /v1/responses` accepts message-array input.
- Streaming responses emit Responses-compatible SSE events.
- Non-streaming responses return a Responses-compatible JSON object.
- The implementation does not call or emulate `/v1/chat/completions` internally.

### Phase 4: Migrate GLM, Kimi, and Qwen runners

Move each channel from direct protocol response writing to Internal Events.

Acceptance:

- Existing `/v1/chat/completions` and `/v1/messages` behavior remains compatible for each migrated channel.
- `/v1/responses` works for each migrated channel through the same Responses renderer.

### Phase 5: Refactor prompt injection

After Internal Request and Internal Events are stable, rebuild prompt injection as a strategy layer between Internal Request and channel request plan.

Acceptance:

- Prompt injection is no longer scattered across response utilities and channel handlers.
- Tool prompt protocol is explicitly represented in the prompt plan.
- Legacy prompt behavior remains available as a strategy during migration.

## Error handling

Internal errors should use a protocol-neutral shape before rendering:

```js
{
  type: "run.failed",
  requestId: "req_xxx",
  responseId: "gen_xxx",
  error: {
    message: "...",
    type: "api_error" | "invalid_request_error" | "rate_limit_error",
    code: null,
    status: 500,
    retryable: false
  }
}
```

Renderers convert this into:

- OpenAI-style error JSON for Chat Completions.
- Claude-style error JSON for Messages.
- Responses-style failed response or error event for Responses.

For errors before streaming starts, routes may return protocol-specific error JSON. For errors after streaming starts, renderers should emit the closest protocol-compatible failure event and close the stream.

## Logging and observability

Request logging should understand protocol separately from channel.

Recommended log fields:

```js
{
  protocol: "chat_completions" | "claude_messages" | "responses",
  path: "/v1/responses",
  model: "...",
  channel: "qwen",
  requestId: "req_xxx",
  responseId: "gen_xxx",
  stream: true,
  status: 200,
  duration: 1234
}
```

Chat transcript logging should aggregate from Internal Events where possible rather than parsing only Chat Completions SSE chunks. This avoids duplicating parsing logic per protocol.

## Testing strategy

### Unit tests

1. Chat Completions request adapter converts messages/tools/tool_choice correctly.
2. Claude Messages request adapter converts system/messages/tools/thinking correctly.
3. Responses request adapter converts string input, message input, and typed input items correctly.
4. Chat renderer converts synthetic Internal Events to Chat Completions chunks.
5. Claude renderer converts synthetic Internal Events to Claude SSE events.
6. Responses renderer converts synthetic Internal Events to Responses SSE events.
7. Non-streaming renderers aggregate text, reasoning, usage, and tool calls correctly.

### Integration tests

1. `/v1/chat/completions` still works for migrated channels.
2. `/v1/messages` still works for migrated channels.
3. `/v1/responses` works for text streaming without using Chat Completions as an internal bridge.
4. Tool-call outputs map correctly across Chat, Claude, and Responses renderers once tool events are enabled.
5. Disabled prompt injection mode still preserves raw request metadata in Internal Request.

### Regression tests

Use synthetic Internal Event streams to avoid requiring live upstream credentials for renderer tests. Channel runner tests can use mocked upstream streams.

## Acceptance criteria

1. `/v1/chat/completions`, `/v1/messages`, and `/v1/responses` are represented as peer protocol adapters.
2. The generation core consumes Internal Request and produces Internal Events.
3. Protocol renderers consume Internal Events and own protocol-specific output shape.
4. Channel runners no longer write client protocol SSE directly after they are migrated.
5. `/v1/responses` is not implemented through a Chat Completions bridge.
6. The architecture provides a clear insertion point for prompt strategy and prompt injection.
7. The migration can happen one channel at a time without requiring a full rewrite.
8. Existing channel-specific infrastructure remains usable: token pools, queues, session affinity, uploads, and upstream stream parsers.

## Spec self-review

- Placeholder scan: no TODO, TBD, or incomplete sections remain.
- Consistency check: protocol adapters, generation core, channel runners, Internal Events, and renderers all have non-overlapping responsibilities.
- Scope check: this design is focused on the Internal Request / Internal Event architecture and does not include the full prompt-injection redesign.
- Ambiguity check: the design explicitly rejects a `/v1/responses -> /v1/chat/completions` bridge and defines `/v1/responses` as a peer protocol over Internal Events.
