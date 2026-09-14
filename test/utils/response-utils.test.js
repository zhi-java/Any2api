import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildDisabledPrompt,
  buildLatestPrompt,
  createJsonContentExtractor,
  extractAssistantResponse,
  latestDeltaStartIndex,
} from '../../src/utils/response-utils.js';

function collectExtractor(chunks) {
  const extractor = createJsonContentExtractor();
  let text = '';
  for (const chunk of chunks) text += extractor.process(chunk);
  return { text, found: extractor.isFound(), done: extractor.isDone() };
}

test('streaming JSON extractor handles compact assistant_response JSON', () => {
  const result = collectExtractor(['{"assistant_response":"hello world","tool_calls":[]}']);
  assert.equal(result.text, 'hello world');
  assert.equal(result.found, true);
  assert.equal(result.done, true);
});

test('streaming JSON extractor handles spaces and marker split across chunks', () => {
  const result = collectExtractor([
    '{"assistant_',
    'response"  :  "hel',
    'lo\\n世界","tool_calls":[]}',
  ]);
  assert.equal(result.text, 'hello\n世界');
  assert.equal(result.found, true);
  assert.equal(result.done, true);
});

test('streaming JSON extractor decodes unicode escapes across chunks', () => {
  const result = collectExtractor([
    '{"assistant_response":"hi \\u4',
    'F60","tool_calls":[]}',
  ]);
  assert.equal(result.text, 'hi 你');
  assert.equal(result.done, true);
});

test('extractAssistantResponse recovers assistant_response from fenced JSON', () => {
  const result = extractAssistantResponse('```json\n{"assistant_response":"正文输出","tool_calls":[]}\n```');
  assert.equal(result.content, '正文输出');
  assert.equal(result.toolCalls, null);
});

test('extractAssistantResponse preserves plain text when output is not JSON', () => {
  const result = extractAssistantResponse('plain answer');
  assert.equal(result.content, 'plain answer');
  assert.equal(result.toolCalls, null);
});

test('buildDisabledPrompt returns captured raw JSON metadata', () => {
  const body = {
    model: 'deepseek-flash',
    messages: [
      { role: 'system', content: 'be precise' },
      { role: 'user', content: 'hello' },
    ],
    tools: [{ type: 'function', function: { name: 'Read', parameters: { type: 'object', properties: {} } } }],
  };
  const raw = JSON.stringify(body);
  const prompt = buildDisabledPrompt({ body, omni: { rawRequestJsonText: raw } });
  assert.equal(prompt, raw);
  assert.match(prompt, /"tools"/);
  assert.match(prompt, /"system"/);
});

test('buildDisabledPrompt falls back to rawBody buffer', () => {
  const raw = '{"input":"hello","instructions":"keep original"}';
  assert.equal(buildDisabledPrompt({ rawBody: Buffer.from(raw), body: { input: 'hello' } }), raw);
});

test('buildDisabledPrompt falls back to full JSON body without joining messages', () => {
  const body = { messages: [{ role: 'user', content: 'a' }, { role: 'user', content: 'b' }] };
  const prompt = buildDisabledPrompt({ body });
  assert.equal(prompt, JSON.stringify(body, null, 2));
  assert.match(prompt, /"role": "user"/);
  assert.notEqual(prompt, 'a\n\nb');
});

test('buildLatestPrompt keeps all parallel tool results after last assistant message', () => {
  const messages = [
    { role: 'system', content: 'sys' },
    { role: 'user', content: 'question' },
    { role: 'assistant', content: 'calling tools' },
    { role: 'user', content: '[系统通知] result 1' },
    { role: 'user', content: '[系统通知] result 2' },
    { role: 'user', content: '[系统通知] result 3' },
  ];
  const prompt = buildLatestPrompt(messages);
  assert.match(prompt, /result 1/);
  assert.match(prompt, /result 2/);
  assert.match(prompt, /result 3/);
  assert.doesNotMatch(prompt, /calling tools/);
  assert.doesNotMatch(prompt, /question/);
});

test('buildLatestPrompt falls back to last user turn without assistant history', () => {
  const messages = [
    { role: 'system', content: 'sys' },
    { role: 'user', content: 'first question' },
  ];
  assert.match(buildLatestPrompt(messages), /first question/);
});

test('latestDeltaStartIndex skips leading assistant echo and rejects unusable prefixes', () => {
  const messages = [
    { role: 'system', content: 's' },
    { role: 'user', content: 'q' },
    { role: 'assistant', content: 'a' },
    { role: 'user', content: 'r1' },
    { role: 'user', content: 'r2' },
  ];
  assert.equal(latestDeltaStartIndex(messages, 2), 3);
  assert.equal(latestDeltaStartIndex(messages, 3), 3);
  assert.equal(latestDeltaStartIndex(messages, 0), null);
  assert.equal(latestDeltaStartIndex(messages, -1), null);
  assert.equal(latestDeltaStartIndex(messages, 5), null);
  assert.equal(latestDeltaStartIndex(messages, 99), null);
});
