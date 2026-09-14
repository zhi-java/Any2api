import test from 'node:test';
import assert from 'node:assert/strict';

import { createChatCompletionsRequestAdapter } from '../../src/protocols/chat-completions/request-adapter.js';
import { createClaudeMessagesRequestAdapter } from '../../src/protocols/claude-messages/request-adapter.js';
import { collectUploadableParts } from '../../src/utils/message-files.js';

function req(path, body) {
  return {
    body,
    headers: {},
    originalUrl: path,
    omni: { promptInjectionEnabled: true, rawRequestJsonText: JSON.stringify(body) },
  };
}

test('Chat adapter maps messages, tools, and tool_choice directly to Internal Request', () => {
  const internal = createChatCompletionsRequestAdapter(req('/v1/chat/completions', {
    model: 'deepseek-flash',
    stream: true,
    messages: [{ role: 'user', content: 'hello' }],
    tools: [{ type: 'function', function: { name: 'Read', description: 'Read file', parameters: { type: 'object', properties: {} } } }],
    tool_choice: { type: 'function', function: { name: 'Read' } },
    max_tokens: 100,
  }));

  assert.equal(internal.protocol, 'chat_completions');
  assert.equal(internal.model.requested, 'deepseek-flash');
  assert.equal(internal.stream, true);
  assert.equal(internal.messages[0].role, 'user');
  assert.deepEqual(internal.messages[0].content, [{ type: 'text', text: 'hello' }]);
  assert.equal(internal.tools[0].name, 'Read');
  assert.equal(internal.toolChoice.mode, 'specific');
  assert.equal(internal.generation.maxTokens, 100);
});

test('Claude adapter maps system, messages, tools, and thinking directly to Internal Request', () => {
  const internal = createClaudeMessagesRequestAdapter(req('/v1/messages', {
    model: 'deepseek-flash',
    stream: true,
    system: 'be concise',
    max_tokens: 100,
    thinking: { type: 'enabled', budget_tokens: 1024 },
    messages: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }],
    tools: [{ name: 'Read', description: 'Read file', input_schema: { type: 'object', properties: {} } }],
    tool_choice: { type: 'tool', name: 'Read' },
  }));

  assert.equal(internal.protocol, 'claude_messages');
  assert.equal(internal.instructions.system, 'be concise');
  assert.equal(internal.messages[0].role, 'user');
  assert.deepEqual(internal.messages[0].content, [{ type: 'text', text: 'hello' }]);
  assert.equal(internal.tools[0].name, 'Read');
  assert.equal(internal.toolChoice.mode, 'specific');
  assert.equal(internal.toolChoice.name, 'Read');
  assert.equal(internal.generation.reasoning.enabled, true);
  assert.equal(internal.generation.reasoning.effort, 1024);
});

test('Claude image content is preserved as uploadable attachment for upstream channels', () => {
  const internal = createClaudeMessagesRequestAdapter(req('/v1/messages', {
    model: 'deepseek-flash',
    stream: true,
    max_tokens: 100,
    messages: [{
      role: 'user',
      content: [
        { type: 'text', text: 'describe this' },
        { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'aGVsbG8=' } },
      ],
    }],
  }));

  const uploads = collectUploadableParts(internal.messages);
  assert.equal(uploads.length, 1);
  assert.equal(uploads[0].kind, 'image');
  assert.equal(uploads[0].mimeType, 'image/png');
  assert.equal(uploads[0].data, 'aGVsbG8=');
});
