import test from 'node:test';
import assert from 'node:assert/strict';

import { createResponsesRequestAdapter } from '../../src/protocols/responses/request-adapter.js';

function req(body) {
  return {
    body,
    headers: {},
    originalUrl: '/v1/responses',
    omni: { promptInjectionEnabled: true, rawRequestJsonText: JSON.stringify(body) },
  };
}

test('Responses adapter maps string input to one user message', () => {
  const body = { model: 'deepseek-flash', input: 'hello' };
  const internal = createResponsesRequestAdapter(req(body));
  assert.equal(internal.protocol, 'responses');
  assert.equal(internal.model.requested, 'deepseek-flash');
  assert.equal(internal.stream, false);
  assert.equal(internal.messages.length, 1);
  assert.equal(internal.messages[0].role, 'user');
  assert.deepEqual(internal.messages[0].content, [{ type: 'text', text: 'hello' }]);
});

test('Responses adapter maps role/content input array', () => {
  const body = { model: 'deepseek-flash', input: [{ role: 'user', content: 'hello' }], stream: true };
  const internal = createResponsesRequestAdapter(req(body));
  assert.equal(internal.stream, true);
  assert.equal(internal.messages[0].role, 'user');
  assert.deepEqual(internal.messages[0].content, [{ type: 'text', text: 'hello' }]);
});

test('Responses adapter maps typed input_text message items', () => {
  const body = {
    model: 'deepseek-flash',
    input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'typed hello' }] }],
    instructions: 'be concise',
    previous_response_id: 'resp_previous',
  };
  const internal = createResponsesRequestAdapter(req(body));
  assert.equal(internal.instructions.system, 'be concise');
  assert.equal(internal.conversation.previousResponseId, 'resp_previous');
  assert.deepEqual(internal.messages[0].content, [{ type: 'text', text: 'typed hello' }]);
});

test('Responses adapter normalizes tools and tool_choice', () => {
  const body = {
    model: 'deepseek-flash',
    input: 'hello',
    tools: [{ type: 'function', name: 'Read', description: 'Read file', parameters: { type: 'object', properties: {} } }],
    tool_choice: { type: 'function', function: { name: 'Read' } },
  };
  const internal = createResponsesRequestAdapter(req(body));
  assert.equal(internal.tools[0].name, 'Read');
  assert.equal(internal.toolChoice.mode, 'specific');
  assert.equal(internal.toolChoice.name, 'Read');
});

test('Responses adapter rejects missing input', () => {
  assert.throws(() => createResponsesRequestAdapter(req({ model: 'deepseek-flash' })), /input is required/);
});
