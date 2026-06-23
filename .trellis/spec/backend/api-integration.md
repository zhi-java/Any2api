# API Integration Guidelines

> Architectural patterns and contracts for integrating external API providers.

---

## Overview

This document captures executable contracts and design decisions for API integration, including authentication flows, format adapters, and error handling patterns.

---

## Design Decisions

### Decision: Unified API Layer Pattern for Streaming Support (2026-06-23)

**Context**: Response Interception pattern (below) could not support streaming responses because streams cannot be captured by mock objects. Need to support both streaming and non-streaming responses in Claude format.

**Options Considered**:
1. **Add streaming branch** - Keep interception for non-streaming, add separate path for streaming
2. **Unified API layer** - Create abstraction layer that returns stream or object, remove interception
3. **Hybrid approach** - Mix of both depending on format

**Decision**: We chose **Unified API Layer** (Option 2) because:
- Single code path for both streaming and non-streaming
- No mock objects or response interception
- Clear separation of concerns: API call → format conversion → response
- Easier to maintain and extend

**Implementation**:

Created `src/api-client.js`:
```javascript
// Unified API layer - returns ReadableStream or Object
export async function callDeepSeekAPI(openaiReq, options = {}) {
  const { stream = false, token } = options;
  
  const response = await fetch('https://api.deepseek.com/v1/chat/completions', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...openaiReq, stream }),
  });
  
  if (!response.ok) throw new Error(`DeepSeek API error ${response.status}`);
  
  return stream ? response.body : await response.json();
}

export async function callGLMAPI(openaiReq, options = {}) {
  const { stream = false, tokenManager } = options;
  const accessToken = await tokenManager.getAccessToken();
  
  const response = await fetch('https://chatglm.cn/chatglm/backend-api/assistant/stream', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${accessToken}`, ...generateGLMHeaders() },
    body: JSON.stringify(convertOpenAIToGLM(openaiReq)),
  });
  
  if (!response.ok) throw new Error(`GLM API error ${response.status}`);
  
  return stream ? response.body : await parseGLMNonStreamResponse(response.body);
}
```

Handler refactor:
```javascript
export async function handleDeepSeekClaude(req, res) {
  const claudeReq = req.body;
  const openaiReq = convertClaudeRequest(claudeReq);
  
  // Unified API call
  const result = await callDeepSeekAPI(openaiReq, {
    stream: claudeReq.stream || false,
    token: process.env.DEEPSEEK_API_KEY,
  });
  
  // Handle based on type
  if (claudeReq.stream) {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
    for await (const event of streamOpenAIToClaude(result, claudeReq.model)) {
      writeClaudeSSE(res, event);
    }
    res.end();
  } else {
    const claudeResp = convertOpenAIResponse(result, claudeReq.model);
    res.json(claudeResp);
  }
}
```

**Why This Works Better**:
- Streaming and non-streaming use same code path
- No mock objects → simpler and more reliable
- Format conversion isolated in adapters
- Easy to add new channels (just add new `call*API` function)

**Migration Impact**:
- Removed 150+ lines of mock response code
- Added 213 lines of unified API layer
- Net result: cleaner, more maintainable architecture

---

### Decision: Response Interception Pattern for Format Adaptation (DEPRECATED 2026-06-23)

**Context**: Need to support multiple API formats (OpenAI, Claude) for the same underlying service without duplicating core logic.

**Options Considered**:
1. **Duplicate handlers** - Separate implementation for each format
2. **Pre-transform + delegate** - Convert request, call original handler, convert response
3. **Response interception** - Inject mock response collector, intercept output

**Decision**: We chose **Response Interception** (Option 3) because:
- Reuses existing handlers without modification
- Maintains single source of truth for business logic
- Clean separation between format adaptation and core processing

**Implementation**:

```javascript
export async function handleDeepSeekClaude(req, res) {
  // 1. Convert request format: Claude → OpenAI
  const openaiReq = convertClaudeRequest(req.body);
  
  // 2. Temporarily replace req.body
  const savedBody = req.body;
  req.body = { ...openaiReq, model: '...', stream: false };
  
  // 3. Create response collector
  let capturedResponse = null;
  let capturedError = null;
  
  const proxyRes = {
    json: (data) => { capturedResponse = data; },
    status: (code) => ({
      json: (data) => { capturedError = { code, data }; }
    }),
    // ... other required methods
  };
  
  // 4. Call original OpenAI handler
  await handleOpenAICompletion(req, proxyRes);
  
  // 5. Restore original req.body
  req.body = savedBody;
  
  // 6. Convert response format: OpenAI → Claude
  const claudeResp = convertOpenAIResponse(capturedResponse, model);
  res.json(claudeResp);
}
```

**Why This Works**:
- Original handler sees correct format → no logic changes needed
- Response capture is non-invasive → just mock `res.json()` and `res.status()`
- Format conversion is isolated in adapters → easy to maintain

**Limitations**:
- Only works for non-streaming responses (streaming requires different approach)
- Requires all Express response methods to be stubbed

---

## Scenario: Multi-Format API Adapter

### 1. Scope / Trigger

**Trigger**: Adding support for Claude API format alongside existing OpenAI format requires cross-layer contract changes:
- Request/response format conversion
- Error format adaptation
- Model name mapping

### 2. Signatures

#### Adapter Module (`src/adapters/claude.js`)

```typescript
// Request conversion
convertClaudeRequest(claudeReq: ClaudeRequest): OpenAIRequest

// Response conversion  
convertOpenAIResponse(openaiResp: OpenAIResponse, model: string): ClaudeResponse

// Streaming conversion (framework only)
streamOpenAIToClaude(openaiStream: ReadableStream): AsyncGenerator<ClaudeSSEEvent>
writeClaudeSSE(res: Response, event: ClaudeSSEEvent): void
```

#### Handler Functions

```typescript
// OpenAI format handler (existing)
handleOpenAICompletion(req: Request, res: Response): Promise<void>

// Claude format handler (new)
handleDeepSeekClaude(req: Request, res: Response): Promise<void>
handleGLMClaude(req: Request, res: Response): Promise<void>
```

### 3. Contracts

#### Claude Request Format

```json
{
  "model": "deepseek-v4-flash",       // Required: string
  "messages": [                       // Required: array, min length 1
    {
      "role": "user",                 // Required: "user" | "assistant"
      "content": "Hello"              // Required: string | Content[]
    }
  ],
  "system": "You are helpful",        // Optional: string
  "max_tokens": 1024,                 // Optional: integer
  "temperature": 0.7,                 // Optional: float [0, 2]
  "top_p": 1.0,                       // Optional: float [0, 1]
  "tools": [...],                     // Optional: Tool[]
  "stream": false                     // Optional: boolean (default false)
}
```

#### Claude Response Format (Non-Streaming)

```json
{
  "id": "msg_...",                    // String: converted from chatcmpl-*
  "type": "message",                  // Literal: "message"
  "role": "assistant",                // Literal: "assistant"
  "content": [                        // Array: content blocks
    {
      "type": "text",                 // "text" | "tool_use"
      "text": "Response text"
    }
  ],
  "model": "deepseek-v4-flash",       // String: from request
  "stop_reason": "end_turn",          // "end_turn" | "tool_use" | "max_tokens"
  "stop_sequence": null,              // String | null
  "usage": {                          // Object
    "input_tokens": 10,               // Integer
    "output_tokens": 20               // Integer
  }
}
```

#### Claude Error Format

```json
{
  "type": "error",                    // Literal: "error"
  "error": {
    "type": "api_error",              // String: error category
    "message": "Error description"    // String: human-readable message
  }
}
```

### 4. Validation & Error Matrix

| Condition | Error Type | HTTP Status | Message |
|-----------|------------|-------------|---------|
| Missing `messages` | `invalid_request_error` | 400 | "Invalid Claude request: messages array is required" |
| Empty `messages` array | `invalid_request_error` | 400 | "messages array must not be empty" |
| Invalid message role | `invalid_request_error` | 400 | "Invalid role: must be 'user' or 'assistant'" |
| OpenAI handler error | `api_error` | 500 | Original error message preserved |
| Missing OpenAI response | `api_error` | 500 | "No response from backend" |
| Invalid OpenAI response structure | `api_error` | 500 | "Invalid OpenAI response: missing choices array" |

### 5. Good/Base/Bad Cases

#### Good Case: Standard Text Completion

**Request**:
```json
{
  "model": "deepseek-v4-flash",
  "messages": [{"role": "user", "content": "1+1=?"}],
  "max_tokens": 1024
}
```

**Expected Response**:
```json
{
  "id": "msg_1782179982423",
  "type": "message",
  "role": "assistant",
  "content": [{"type": "text", "text": "2"}],
  "model": "deepseek-v4-flash",
  "stop_reason": "end_turn",
  "usage": {"input_tokens": 5, "output_tokens": 1}
}
```

#### Base Case: Multi-Turn Conversation

**Request**:
```json
{
  "model": "deepseek-v4-flash",
  "messages": [
    {"role": "user", "content": "What is 1+1?"},
    {"role": "assistant", "content": "1+1 equals 2."},
    {"role": "user", "content": "What about 2+2?"}
  ],
  "max_tokens": 1024
}
```

**Expected**: Proper context handling, response continues conversation.

#### Bad Case: Empty Messages Array

**Request**:
```json
{
  "model": "deepseek-v4-flash",
  "messages": [],
  "max_tokens": 1024
}
```

**Expected Response** (400):
```json
{
  "type": "error",
  "error": {
    "type": "invalid_request_error",
    "message": "Invalid Claude request: messages array is required and must not be empty"
  }
}
```

### 6. Tests Required

#### Unit Tests

**Adapter Functions**:
```javascript
describe('convertClaudeRequest', () => {
  it('converts basic user message', () => {
    const input = {
      messages: [{ role: 'user', content: 'Hi' }],
      max_tokens: 100
    };
    const output = convertClaudeRequest(input);
    
    assert.equal(output.messages[0].role, 'user');
    assert.equal(output.messages[0].content, 'Hi');
    assert.equal(output.max_tokens, 100);
  });
  
  it('throws on missing messages', () => {
    assert.throws(() => convertClaudeRequest({}), /messages array is required/);
  });
});

describe('convertOpenAIResponse', () => {
  it('converts basic completion response', () => {
    const input = {
      id: 'chatcmpl-123',
      choices: [{
        message: { role: 'assistant', content: 'Hello' },
        finish_reason: 'stop'
      }],
      usage: { prompt_tokens: 5, completion_tokens: 2 }
    };
    const output = convertOpenAIResponse(input, 'test-model');
    
    assert.equal(output.type, 'message');
    assert.equal(output.role, 'assistant');
    assert.equal(output.content[0].text, 'Hello');
    assert.equal(output.stop_reason, 'end_turn');
  });
  
  it('throws on invalid response structure', () => {
    assert.throws(() => convertOpenAIResponse({}, 'model'), /missing choices array/);
  });
});
```

#### Integration Tests

**End-to-End API Call**:
```javascript
describe('POST /deepseek/v1/messages', () => {
  it('returns Claude format response', async () => {
    const res = await request(app)
      .post('/deepseek/v1/messages')
      .set('Authorization', 'Bearer test-key')
      .set('anthropic-version', '2023-06-01')
      .send({
        model: 'deepseek-v4-flash',
        messages: [{ role: 'user', content: '1+1=?' }],
        max_tokens: 100
      });
    
    assert.equal(res.status, 200);
    assert.equal(res.body.type, 'message');
    assert.equal(res.body.role, 'assistant');
    assert(Array.isArray(res.body.content));
    assert.equal(res.body.content[0].type, 'text');
  });
  
  it('returns 400 on invalid request', async () => {
    const res = await request(app)
      .post('/deepseek/v1/messages')
      .set('Authorization', 'Bearer test-key')
      .send({ messages: [] });
    
    assert.equal(res.status, 400);
    assert.equal(res.body.type, 'error');
  });
});
```

### 7. Wrong vs Correct

#### Wrong: Direct Format Conversion in Handler

```javascript
// ❌ Wrong: Mixing format logic with business logic
export async function handleDeepSeekClaude(req, res) {
  // Format conversion scattered throughout handler
  const messages = req.body.messages.map(msg => {
    if (msg.role === 'user') {
      return { role: 'user', content: msg.content };
    }
    // ... more conversion logic mixed with processing
  });
  
  // Business logic intertwined with format handling
  const result = await callDeepSeek(messages);
  
  // Response conversion also mixed in
  res.json({
    type: 'message',
    content: [{ type: 'text', text: result.text }]
  });
}
```

**Problems**:
- Format logic duplicated across handlers
- Hard to maintain consistency
- Business logic obscured by conversion code

#### Correct: Isolated Adapter Pattern

```javascript
// ✅ Correct: Clean separation via adapter
export async function handleDeepSeekClaude(req, res) {
  try {
    // 1. Convert request (isolated in adapter)
    const openaiReq = convertClaudeRequest(req.body);
    
    // 2. Reuse existing OpenAI handler (business logic)
    const savedBody = req.body;
    req.body = { ...openaiReq, model: req.body.model, stream: false };
    
    const proxyRes = {
      json: (data) => { capturedResponse = data; },
      status: (code) => ({ json: (data) => { capturedError = { code, data }; } }),
      // ... required stubs
    };
    
    await handleOpenAICompletion(req, proxyRes);
    req.body = savedBody;
    
    // 3. Convert response (isolated in adapter)
    if (capturedError) {
      return res.status(capturedError.code).json({
        type: 'error',
        error: { type: 'api_error', message: capturedError.data.error?.message }
      });
    }
    
    const claudeResp = convertOpenAIResponse(capturedResponse, req.body.model);
    res.json(claudeResp);
    
  } catch (err) {
    res.status(500).json({
      type: 'error',
      error: { type: 'api_error', message: err.message }
    });
  }
}
```

**Benefits**:
- Format conversion isolated in `src/adapters/claude.js`
- Business logic reused from existing handler
- Easy to add new formats (just add new adapter)
- Clear error boundaries

---

## Scenario: Three-Tier Token Authentication

### 1. Scope / Trigger

**Trigger**: GLM API requires custom three-tier token flow (guest → refresh → access) with signature-based authentication, different from standard Bearer token.

### 2. Signatures

#### Token Manager Class

```typescript
class GlmTokenManager {
  constructor()
  
  // Public API
  async getAccessToken(): Promise<string>
  reset(): void
  
  // Private methods
  private async _acquireToken(): Promise<string>
  private async _guestAccess(): Promise<GuestTokenResponse>
  private async _refresh(refreshToken: string): Promise<RefreshTokenResponse>
}
```

#### Signature Generation

```typescript
function makeTimestamp(): string              // Returns: "1234567890123"
function makeNonce(): string                   // Returns: "a1b2c3..." (32 chars)
function makeSign(timestamp: string, nonce: string): string  // Returns: MD5 hash
```

### 3. Contracts

#### Environment Variables

```bash
# Optional: If not set, uses guest mode
GLM_REFRESH_TOKEN=eyJhbGciOiJIUzI1NiIs...
```

#### Authentication Headers

```http
POST /chatglm/user-api/guest/access
Content-Type: application/json;charset=utf-8
App-Name: chatglm
X-Device-Id: <32-char hex UUID>
X-Request-Id: <32-char hex UUID>
X-App-Platform: pc
X-App-Version: 0.0.1
X-App-fr: browser
X-Lang: zh-CN
X-Timestamp: <signed timestamp>
X-Nonce: <random 32-char hex>
X-Sign: <MD5(timestamp-nonce-SECRET)>
```

#### Token Response Format

```json
{
  "status": 0,
  "result": {
    "refresh_token": "eyJ...",
    "access_token": "eyJ...",
    "user_id": "xxx"
  }
}
```

### 4. Validation & Error Matrix

| Condition | Error Code | Action |
|-----------|------------|--------|
| Access token valid (< 59 min old) | - | Use cached token |
| Access token expired | - | Call refresh endpoint |
| Refresh token invalid | 40102 | Fall back to guest access |
| Guest access fails | 400/401 | Throw error to client |
| Signature mismatch | 401 | Regenerate signature |

### 5. Good/Base/Bad Cases

#### Good Case: First Request (Guest Mode)

**Flow**:
1. No cached tokens → Call `guest/access`
2. Receive `refresh_token` + `access_token`
3. Cache both tokens (access_token valid for 1 hour)
4. Return access_token for API request

#### Base Case: Subsequent Request (Cached Token)

**Flow**:
1. Check cache → Found valid access_token (< 59 min old)
2. Return cached access_token immediately
3. No API calls needed

#### Bad Case: Refresh Token Expired

**Flow**:
1. Check cache → access_token expired
2. Call `user/refresh` with cached refresh_token
3. Receive 40102 error → refresh_token also expired
4. Fall back to `guest/access` to get new tokens
5. Cache new tokens and proceed

### 6. Tests Required

#### Unit Tests

```javascript
describe('GlmTokenManager', () => {
  it('caches access token for 1 hour', async () => {
    const manager = new GlmTokenManager();
    const token1 = await manager.getAccessToken();
    const token2 = await manager.getAccessToken();
    
    assert.equal(token1, token2);  // Should return cached token
    assert.equal(mockFetch.callCount, 1);  // Only one API call
  });
  
  it('refreshes expired access token', async () => {
    const manager = new GlmTokenManager();
    manager.expiresAt = Date.now() - 1000;  // Force expiration
    
    const token = await manager.getAccessToken();
    
    assert(token);
    assert(manager.expiresAt > Date.now());  // New expiration set
  });
  
  it('falls back to guest mode on refresh failure', async () => {
    const manager = new GlmTokenManager();
    manager.refreshToken = 'expired-token';
    mockRefreshEndpoint.mockReturnValueOnce({ code: 40102 });
    
    const token = await manager.getAccessToken();
    
    assert(token);
    assert(mockGuestEndpoint.called);  // Guest endpoint was called
  });
});
```

### 7. Wrong vs Correct

#### Wrong: No Token Caching

```javascript
// ❌ Wrong: Fetching new token on every request
async function callGLMAPI(message) {
  // No caching - hits guest/access every time
  const tokens = await fetch('/guest/access', {
    method: 'POST',
    body: '{}'
  }).then(r => r.json());
  
  const accessToken = tokens.result.access_token;
  
  return fetch('/assistant/stream', {
    headers: { Authorization: `Bearer ${accessToken}` },
    body: JSON.stringify({ messages: [message] })
  });
}
```

**Problems**:
- Unnecessary API calls (guest/access has rate limits)
- Slower response times
- Wastes GLM API quota

#### Correct: Token Caching with Expiration

```javascript
// ✅ Correct: Cache with automatic refresh
class GlmTokenManager {
  constructor() {
    this.refreshToken = process.env.GLM_REFRESH_TOKEN || null;
    this.accessToken = null;
    this.expiresAt = 0;
    this._pending = null;  // Concurrent request deduplication
  }
  
  async getAccessToken() {
    // Return cached if still valid (with 1-min buffer)
    if (this.accessToken && Date.now() < this.expiresAt - 60_000) {
      return this.accessToken;
    }
    
    // Deduplicate concurrent requests
    if (this._pending) return this._pending;
    
    this._pending = this._acquireToken();
    try {
      return await this._pending;
    } finally {
      this._pending = null;
    }
  }
  
  async _acquireToken() {
    // Try refresh first if we have a token
    if (this.refreshToken) {
      try {
        const result = await this._refresh(this.refreshToken);
        this.accessToken = result.access_token;
        this.expiresAt = Date.now() + 3600 * 1000;
        return this.accessToken;
      } catch (err) {
        console.warn('Refresh failed, falling back to guest:', err.message);
      }
    }
    
    // Fall back to guest mode
    const guest = await this._guestAccess();
    this.refreshToken = guest.refresh_token;
    this.accessToken = guest.access_token;
    this.expiresAt = Date.now() + 3600 * 1000;
    return this.accessToken;
  }
}

// Usage
const tokenManager = new GlmTokenManager();

async function callGLMAPI(message) {
  const token = await tokenManager.getAccessToken();  // Fast cached lookup
  
  return fetch('/assistant/stream', {
    headers: { Authorization: `Bearer ${token}` },
    body: JSON.stringify({ messages: [message] })
  });
}
```

**Benefits**:
- Single token fetch serves many requests
- Automatic refresh before expiration
- Concurrent request deduplication
- Graceful fallback to guest mode

---

## Common Mistakes

### Mistake: Forgetting to Restore req.body

**Symptom**: Subsequent middleware or error handlers see modified request.

**Cause**: Response interception modifies `req.body` but doesn't restore it on error paths.

**Fix**:
```javascript
export async function handleDeepSeekClaude(req, res) {
  const savedBody = req.body;
  
  try {
    req.body = { ...convertedRequest };
    await handleOpenAICompletion(req, proxyRes);
    
    // Always restore in finally block
  } finally {
    req.body = savedBody;
  }
}
```

**Prevention**: Use `try-finally` to guarantee restoration.

---

### Mistake: Not Validating Adapter Input

**Symptom**: Cryptic errors deep in conversion logic.

**Cause**: Adapter assumes valid input structure without checking.

**Fix**:
```javascript
export function convertClaudeRequest(claudeReq) {
  // Validate at entry point
  if (!claudeReq) {
    throw new Error('Invalid Claude request: request body is required');
  }
  
  if (!Array.isArray(claudeReq.messages) || claudeReq.messages.length === 0) {
    throw new Error('Invalid Claude request: messages array is required and must not be empty');
  }
  
  // Now safe to proceed
  const openaiMessages = convertClaudeMessages(claudeReq.messages, claudeReq.system);
  // ...
}
```

**Prevention**: Validate all required fields at adapter entry points.

---

## Anti-Patterns

### Don't: Mix Format Logic with Business Logic

```javascript
// ❌ Bad: Format conversion scattered in handler
async function handleRequest(req, res) {
  let messages;
  if (req.path === '/v1/messages') {
    // Claude format
    messages = req.body.messages.map(m => ({ role: m.role, content: m.content }));
  } else {
    // OpenAI format
    messages = req.body.messages;
  }
  
  const result = await processMessages(messages);
  
  if (req.path === '/v1/messages') {
    res.json({ type: 'message', content: [{ type: 'text', text: result }] });
  } else {
    res.json({ choices: [{ message: { content: result } }] });
  }
}
```

**Instead**: Use dedicated adapters and handlers per format.

---

### Don't: Block Token Refresh Unnecessarily

```javascript
// ❌ Bad: Sequential token refresh blocks all requests
let tokenLock = false;

async function getToken() {
  while (tokenLock) {
    await sleep(100);  // Busy wait
  }
  
  tokenLock = true;
  try {
    return await fetchNewToken();
  } finally {
    tokenLock = false;
  }
}
```

**Instead**: Use request deduplication with promises:

```javascript
// ✅ Good: First request fetches, others await same promise
let pending = null;

async function getToken() {
  if (pending) return pending;
  
  pending = fetchNewToken();
  try {
    return await pending;
  } finally {
    pending = null;
  }
}
```

---

## Scenario: Multi-Token Pool Management

### 1. Scope / Trigger

**Trigger**: Token pool management requires cross-layer changes:
- Environment variable configuration
- Token selection strategy
- Independent caching per token
- Automatic fallback mechanism

### 2. Signatures

#### Token Manager Class

```typescript
class GlmTokenManager {
  constructor()
  
  // Public API
  async getAccessToken(): Promise<string>
  reset(): void
  
  // Private methods
  private _loadTokens(): string[]
  private _selectToken(): string | null
  private _getAccessTokenForRefresh(refreshToken: string): Promise<string>
  private _guestAccessToken(): Promise<string>
  private _guestAccess(): Promise<GuestTokenResponse>
  private _refresh(refreshToken: string): Promise<RefreshTokenResponse>
}
```

### 3. Contracts

#### Environment Variables

```bash
# Priority 1: Multiple tokens (comma-separated)
GLM_REFRESH_TOKENS=token1,token2,token3

# Priority 2: Single token (backward compatible)
GLM_REFRESH_TOKEN=single_token

# Priority 3: Empty (guest mode)
# (no configuration)
```

**Configuration Priority**: `GLM_REFRESH_TOKENS` > `GLM_REFRESH_TOKEN` > guest mode

#### Token Cache Structure

```typescript
// Map<refreshToken | 'guest', TokenCacheEntry>
interface TokenCacheEntry {
  accessToken: string;      // Current access token
  expiresAt: number;        // Expiration timestamp (ms)
  userId: string | null;    // Associated user ID
}
```

### 4. Validation & Error Matrix

| Condition | Action |
|-----------|--------|
| No tokens configured | Use guest mode |
| Single token configured | Load as 1-element pool |
| Multiple tokens (valid CSV) | Parse and load all |
| Token refresh fails | Fall back to guest mode |
| All tokens fail | Use guest mode (no hard failure) |
| Guest mode fails | Throw error to client |

### 5. Good/Base/Bad Cases

#### Good Case: Multiple Tokens with Round-Robin

**Configuration**:
```bash
GLM_REFRESH_TOKENS=token_a,token_b,token_c
```

**Behavior**:
- Request 1 → Uses `token_a`
- Request 2 → Uses `token_b`
- Request 3 → Uses `token_c`
- Request 4 → Uses `token_a` (wraps around)

**Expected**: Each token's access_token cached independently, no interference.

#### Base Case: Single Token (Backward Compatible)

**Configuration**:
```bash
GLM_REFRESH_TOKEN=single_token
```

**Behavior**:
- All requests use same token
- Access token cached normally
- Functions identically to pre-enhancement behavior

#### Bad Case: All Tokens Expired

**Configuration**:
```bash
GLM_REFRESH_TOKENS=expired1,expired2
```

**Flow**:
1. Try `expired1` → Refresh fails
2. Try `expired2` → Refresh fails
3. Fall back to guest mode
4. Guest mode succeeds → Continue with guest token

**Expected**: System remains functional via guest mode fallback.

### 6. Tests Required

#### Unit Tests

```javascript
describe('GlmTokenManager - Token Pool', () => {
  it('loads multiple tokens from GLM_REFRESH_TOKENS', () => {
    process.env.GLM_REFRESH_TOKENS = 'token1,token2,token3';
    const manager = new GlmTokenManager();
    
    assert.equal(manager.tokens.length, 3);
    assert.deepEqual(manager.tokens, ['token1', 'token2', 'token3']);
  });
  
  it('round-robin selects tokens in order', () => {
    process.env.GLM_REFRESH_TOKENS = 'a,b,c';
    const manager = new GlmTokenManager();
    
    assert.equal(manager._selectToken(), 'a');
    assert.equal(manager._selectToken(), 'b');
    assert.equal(manager._selectToken(), 'c');
    assert.equal(manager._selectToken(), 'a');  // Wraps
  });
  
  it('caches access tokens independently per refresh token', async () => {
    process.env.GLM_REFRESH_TOKENS = 'token1,token2';
    const manager = new GlmTokenManager();
    
    const access1 = await manager.getAccessToken();
    const access2 = await manager.getAccessToken();
    
    // Different refresh tokens should get different access tokens
    // (or same if cached from previous request)
    assert(manager.tokenCache.size > 0);
  });
  
  it('falls back to guest mode on token failure', async () => {
    process.env.GLM_REFRESH_TOKENS = 'invalid_token';
    const manager = new GlmTokenManager();
    
    // Mock refresh to fail
    manager._refresh = async () => { throw new Error('Token expired'); };
    
    const accessToken = await manager.getAccessToken();
    
    // Should have fallen back to guest
    assert(manager.tokenCache.has('guest'));
    assert(accessToken);
  });
});
```

#### Integration Tests

```javascript
describe('GLM API with Token Pool', () => {
  it('distributes requests across token pool', async () => {
    process.env.GLM_REFRESH_TOKENS = 'token1,token2,token3';
    
    const responses = [];
    for (let i = 0; i < 6; i++) {
      const res = await callGLMAPI({ messages: [{ role: 'user', content: `Test ${i}` }] }, {
        tokenManager: new GlmTokenManager(),
      });
      responses.push(res);
    }
    
    assert.equal(responses.length, 6);
    // Each request should succeed
    responses.forEach(r => assert(r.choices[0].message.content));
  });
});
```

### 7. Wrong vs Correct

#### Wrong: No Independent Caching

```javascript
// ❌ Wrong: Single cache for all tokens
class GlmTokenManager {
  constructor() {
    this.tokens = this._loadTokens();
    this.accessToken = null;  // Shared cache
    this.expiresAt = 0;
  }
  
  async getAccessToken() {
    if (this.accessToken && Date.now() < this.expiresAt) {
      return this.accessToken;  // Wrong token returned
    }
    
    const refreshToken = this._selectToken();
    const result = await this._refresh(refreshToken);
    this.accessToken = result.access_token;  // Overwrites
    return this.accessToken;
  }
}
```

**Problems**:
- Token A's access_token overwritten by Token B's
- Cache collision causes wrong credentials
- Each request invalidates previous cache

#### Correct: Independent Caching per Token

```javascript
// ✅ Correct: Map-based independent caching
class GlmTokenManager {
  constructor() {
    this.tokens = this._loadTokens();
    this.tokenCache = new Map();  // Keyed by refresh token
    this.currentIndex = 0;
  }
  
  async _getAccessTokenForRefresh(refreshToken) {
    // Check cache for THIS specific refresh token
    const cached = this.tokenCache.get(refreshToken);
    if (cached && Date.now() < cached.expiresAt - 60_000) {
      return cached.accessToken;
    }
    
    // Refresh and cache under THIS refresh token
    const result = await this._refresh(refreshToken);
    this.tokenCache.set(refreshToken, {
      accessToken: result.access_token,
      expiresAt: Date.now() + 3600 * 1000,
    });
    
    return result.access_token;
  }
}
```

**Benefits**:
- Each refresh token has isolated cache
- No cache collision
- Correct credentials for each request

---

## Related Specs

- [Error Handling](./error-handling.md) - API error format standards
- [Quality Guidelines](./quality-guidelines.md) - Code review checklist

---

**Last Updated**: 2026-06-23
**Contributors**: AI Integration Team
