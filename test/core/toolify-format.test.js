import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildToolCallIndexFromMessages,
  formatAssistantToolCallsForAI,
  formatToolResultForAI,
  preprocessMessagesForToolify,
} from '../../src/core/toolify-format.js';
import { getRecentToolCallIndex, recordResponseToolCalls } from '../../src/services/conversation.js';

const trigger = '<Function_AB12_Start/>';

const readCall = {
  id: 'call_read',
  type: 'function',
  function: {
    name: 'read_file',
    arguments: JSON.stringify({ path: 'README.md' }),
  },
};

test('assistant tool calls become one trigger XML block', () => {
  const xml = formatAssistantToolCallsForAI([readCall], trigger);
  assert.match(xml, new RegExp(`^${trigger.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\n<function_calls>`));
  assert.match(xml, /<function_call>/);
  assert.match(xml, /<tool>read_file<\/tool>/);
  assert.match(xml, /<args_json><!\[CDATA\[{"path":"README.md"}\]\]><\/args_json>/);
  assert.match(xml, /<\/function_calls>$/);
});

test('assistant multiple tool calls are placed inside one wrapper', () => {
  const xml = formatAssistantToolCallsForAI([
    readCall,
    { id: 'call_write', function: { name: 'write_file', arguments: { path: 'out.txt', content: 'ok' } } },
  ], trigger);
  assert.equal((xml.match(/<function_calls>/g) || []).length, 1);
  assert.equal((xml.match(/<function_call>/g) || []).length, 2);
  assert.match(xml, /<tool>read_file<\/tool>/);
  assert.match(xml, /<tool>write_file<\/tool>/);
});

test('assistant text is preserved before XML during preprocessing', () => {
  const processed = preprocessMessagesForToolify([
    { role: 'assistant', content: 'I will inspect it.', tool_calls: [readCall] },
  ], trigger);
  assert.equal(processed.length, 1);
  assert.equal(processed[0].role, 'assistant');
  assert.equal(processed[0].tool_calls, undefined);
  const text = processed[0].content[0].text;
  assert.match(text, /^I will inspect it\.\n<Function_AB12_Start\/>/);
  assert.match(text, /<function_calls>/);
});

test('CDATA escaping preserves embedded CDATA close marker', () => {
  const xml = formatAssistantToolCallsForAI([
    { id: 'call_escape', function: { name: 'write_file', arguments: { content: 'a]]>b' } } },
  ], trigger);
  assert.match(xml, /<!\[CDATA\[{"content":"a\]\]\]\]><!\[CDATA\[>b"}\]\]>/);
});

test('non-object assistant arguments are rejected', () => {
  assert.throws(
    () => formatAssistantToolCallsForAI([{ id: 'bad', function: { name: 'bad_tool', arguments: '[]' } }], trigger),
    (err) => err.status === 400 && err.code === 'invalid_tool_arguments',
  );
});

test('tool call index resolves historical assistant calls', () => {
  const index = buildToolCallIndexFromMessages([{ role: 'assistant', tool_calls: [readCall] }]);
  assert.deepEqual(index.get('call_read'), {
    name: 'read_file',
    arguments: '{"path":"README.md"}',
  });
});

test('tool result messages are converted to Toolify result blocks', () => {
  const processed = preprocessMessagesForToolify([
    { role: 'assistant', content: null, tool_calls: [readCall] },
    { role: 'tool', tool_call_id: 'call_read', content: [{ type: 'text', text: 'file content' }] },
  ], trigger);
  assert.equal(processed[1].role, 'user');
  const text = processed[1].content[0].text;
  assert.match(text, /^\[系统通知\]/);
  assert.match(text, /工具名称：read_file/);
  assert.match(text, /调用参数：{"path":"README.md"}/);
  assert.match(text, /<tool_result>\n<!\[CDATA\[file content\]\]>\n<\/tool_result>/);
});

test('tool result messages can resolve calls from a seeded response index', () => {
  const seed = new Map([
    ['call_previous', { name: 'shell_command', arguments: '{"command":"pwd"}' }],
  ]);
  const processed = preprocessMessagesForToolify([
    { role: 'tool', tool_call_id: 'call_previous', content: 'D:\\tools\\ting13' },
  ], trigger, seed);
  assert.equal(processed.length, 1);
  assert.equal(processed[0].role, 'user');
  const text = processed[0].content[0].text;
  assert.match(text, /工具名称：shell_command/);
  assert.match(text, /调用参数：{"command":"pwd"}/);
  assert.match(text, /ing13/);
});

test('tool result messages can resolve calls from recent streamed tool-call cache', () => {
  recordResponseToolCalls('resp_recent_toolify', [
    { id: 'call_recent_toolify', function: { name: 'read_file', arguments: '{"path":"README.md"}' } },
  ]);
  const processed = preprocessMessagesForToolify([
    { role: 'tool', tool_call_id: 'call_recent_toolify', content: 'file content' },
  ], trigger, getRecentToolCallIndex(['call_recent_toolify']));
  assert.equal(processed[0].role, 'user');
  const text = processed[0].content[0].text;
  assert.match(text, /工具名称：read_file/);
  assert.match(text, /调用参数：{"path":"README.md"}/);
  assert.match(text, /file content/);
});

test('missing tool_call_id reference is rejected', () => {
  assert.throws(
    () => preprocessMessagesForToolify([{ role: 'tool', tool_call_id: 'missing', content: 'result' }], trigger),
    (err) => err.status === 400 && err.code === 'invalid_tool_message',
  );
});

test('formatToolResultForAI emits escaped Toolify block directly', () => {
  const result = formatToolResultForAI('read_file', '{"path":"README.md"}', 'ok </tool_result> ]]>');
  assert.match(result, /^\[系统通知\]/);
  assert.match(result, /工具名称：read_file/);
  assert.match(result, /调用参数：{"path":"README.md"}/);
  assert.match(result, /执行结果：/);
  assert.match(result, /请基于以上结果判断任务进度/);
  assert.match(result, /重新 Read 验证、重新运行测试都是正当调用/);
  assert.match(result, /<!\[CDATA\[ok <\/tool_result> \]\]\]\]><!\[CDATA\[>\]\]>/);
});

test('formatToolResultForAI truncates oversized argument echo but keeps result intact', () => {
  const bigArgs = JSON.stringify({ path: 'big.txt', content: 'x'.repeat(600) });
  const result = formatToolResultForAI('write_file', bigArgs, 'written');
  assert.match(result, /参数过长已截断，共 \d+ 字符/);
  assert.doesNotMatch(result, /x{300}/);
  assert.match(result, /<!\[CDATA\[written\]\]>/);
});

test('read-like tool results append edit-first nudge; other tools do not', () => {
  for (const name of ['Read', 'read_file', 'view_file']) {
    const result = formatToolResultForAI(name, '{"path":"a.js"}', 'content');
    assert.match(result, /必须用编辑类工具做精确替换/);
    assert.match(result, /禁止用写入类工具整文件重写覆盖/);
    assert.match(result, /拆成多轮小编辑分段完成/);
  }
  assert.doesNotMatch(formatToolResultForAI('Bash', '{"command":"ls"}', 'ok'), /编辑类工具/);
  assert.doesNotMatch(formatToolResultForAI('write_file', '{"path":"a.js"}', 'ok'), /编辑类工具/);
  assert.doesNotMatch(formatToolResultForAI('ReadMcpResource', '{"uri":"x"}', 'ok'), /编辑类工具/);
});

test('preprocess is a no-op without trigger', () => {
  const messages = [{ role: 'assistant', content: 'x', tool_calls: [readCall] }];
  assert.equal(preprocessMessagesForToolify(messages, null), messages);
});
