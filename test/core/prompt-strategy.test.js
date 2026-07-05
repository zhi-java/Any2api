import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildXmlToolInstructions,
  createPromptPlan,
  createXmlToolCallDetector,
  generateTriggerSignal,
  parseXmlToolCallsDetailed,
  parseXmlToolCallsFromText,
} from '../../src/core/prompt-strategy.js';

const tools = [{
  type: 'function',
  function: {
    name: 'Read',
    description: 'Read a file from disk',
    parameters: {
      type: 'object',
      properties: {
        file_path: { type: 'string', description: 'Absolute path' },
      },
      required: ['file_path'],
    },
  },
}];

function rawReq(body, overrides = {}) {
  return {
    body,
    headers: {},
    any2api: {
      promptInjectionEnabled: true,
      rawRequestJsonText: JSON.stringify(body),
      ...(overrides.any2api || {}),
    },
    ...overrides,
  };
}

test('generateTriggerSignal returns Toolify-style trigger', () => {
  assert.match(generateTriggerSignal(), /^<Function_[A-Za-z0-9]{4}_Start\/>$/);

  const originalRandom = Math.random;
  try {
    Math.random = () => 0;
    assert.equal(generateTriggerSignal(), '<Function_AAAA_Start/>');
  } finally {
    Math.random = originalRandom;
  }
});

test('XML instructions include tools and do not include old JSON wrapper', () => {
  const instructions = buildXmlToolInstructions({ tools, toolChoice: 'auto', triggerSignal: '<Function_AB12_Start/>' });
  assert.match(instructions, /<Function_AB12_Start\/>/);
  assert.match(instructions, /<function_calls>/);
  assert.match(instructions, /<tool>Read<\/tool>/);
  assert.match(instructions, /file_path/);
  assert.doesNotMatch(instructions, /assistant_response/);
  assert.doesNotMatch(instructions, /"tool_calls"/);
});

test('XML instructions honor tool_choice variants', () => {
  assert.equal(buildXmlToolInstructions({ tools, toolChoice: 'none', triggerSignal: '<Function_AB12_Start/>' }), '');

  const required = buildXmlToolInstructions({ tools, toolChoice: 'required', triggerSignal: '<Function_AB12_Start/>' });
  assert.match(required, /MUST call at least one tool/);

  const specific = buildXmlToolInstructions({
    tools,
    toolChoice: { type: 'function', function: { name: 'Read' } },
    triggerSignal: '<Function_AB12_Start/>',
  });
  assert.match(specific, /only the tool named `Read`/);
});

test('createPromptPlan disables injection using raw JSON prompt', () => {
  const body = {
    model: 'deepseek-v4-flash',
    messages: [
      { role: 'system', content: 'be precise' },
      { role: 'user', content: 'hello' },
    ],
    tools,
    tool_choice: 'required',
  };
  const raw = JSON.stringify(body);
  const plan = createPromptPlan({
    req: rawReq(body, { any2api: { promptInjectionEnabled: false, rawRequestJsonText: raw } }),
    tools,
    toolChoice: 'required',
  });

  assert.equal(plan.promptInjectionDisabled, true);
  assert.equal(plan.disabledPrompt, raw);
  assert.deepEqual(plan.tools, []);
  assert.equal(plan.toolChoice, 'none');
  assert.equal(plan.toolCallingEnabled, false);
  assert.equal(plan.triggerSignal, null);
  assert.equal(plan.parseToolCalls('{"tool_calls":[]}'), null);
});

test('createPromptPlan enables XML strategy with request-local trigger', () => {
  const plan = createPromptPlan({ req: rawReq({ messages: [{ role: 'user', content: 'hi' }] }), tools, toolChoice: 'auto' });
  assert.equal(plan.promptInjectionDisabled, false);
  assert.equal(plan.toolCallingEnabled, true);
  assert.match(plan.triggerSignal, /^<Function_[A-Za-z0-9]{4}_Start\/>$/);
  assert.match(plan.toolInstructions, new RegExp(plan.triggerSignal.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
});

test('parseXmlToolCallsFromText parses CDATA args', () => {
  const trigger = '<Function_AB12_Start/>';
  const parsed = parseXmlToolCallsFromText(`prefix\n${trigger}\n<function_calls>\n<function_call>\n<tool>Read</tool>\n<args_json><![CDATA[{"file_path":"C:\\\\repo\\\\README.md"}]]></args_json>\n</function_call>\n</function_calls>`, { triggerSignal: trigger, tools });
  assert.equal(parsed.content, 'prefix');
  assert.equal(parsed.toolCalls.length, 1);
  assert.equal(parsed.toolCalls[0].function.name, 'Read');
  assert.equal(JSON.parse(parsed.toolCalls[0].function.arguments).file_path, 'C:\\repo\\README.md');
});

test('parseXmlToolCallsFromText parses multiple calls and non-CDATA args', () => {
  const trigger = '<Function_AB12_Start/>';
  const parsed = parseXmlToolCallsFromText(`${trigger}\n<function_calls>\n<function_call><tool>Read</tool><args_json>{"file_path":"a"}</args_json></function_call>\n<function_call><tool>Read</tool><args_json>{"file_path":"b"}</args_json></function_call>\n</function_calls>`, { triggerSignal: trigger, tools });
  assert.equal(parsed.toolCalls.length, 2);
  assert.deepEqual(JSON.parse(parsed.toolCalls[1].function.arguments), { file_path: 'b' });
});

test('parseXmlToolCallsFromText ignores trigger text inside args_json', () => {
  const trigger = '<Function_AB12_Start/>';
  const parsed = parseXmlToolCallsFromText(`${trigger}\n<function_calls>\n<function_call><tool>Read</tool><args_json><![CDATA[{"file_path":"/tmp/<Function_AB12_Start/>.txt"}]]></args_json></function_call>\n</function_calls>`, { triggerSignal: trigger, tools });
  assert.equal(parsed.toolCalls.length, 1);
  assert.equal(JSON.parse(parsed.toolCalls[0].function.arguments).file_path, '/tmp/<Function_AB12_Start/>.txt');
});

test('parseXmlToolCallsFromText ignores protocol-like text inside args_json', () => {
  const trigger = '<Function_AB12_Start/>';
  const filePath = '/tmp/<Function_AB12_Start/> <function_calls><function_call><tool>Read</tool><args_json>{}</args_json></function_call></function_calls>.txt';
  const parsed = parseXmlToolCallsFromText(`${trigger}\n<function_calls>\n<function_call><tool>Read</tool><args_json><![CDATA[${JSON.stringify({ file_path: filePath })}]]></args_json></function_call>\n</function_calls>`, { triggerSignal: trigger, tools });
  assert.equal(parsed.toolCalls.length, 1);
  assert.equal(JSON.parse(parsed.toolCalls[0].function.arguments).file_path, filePath);
});

test('parseXmlToolCallsFromText ignores closing-tag text inside args_json', () => {
  const trigger = '<Function_AB12_Start/>';
  const filePath = '/tmp/</function_calls>.txt';
  const parsed = parseXmlToolCallsFromText(`${trigger}\n<function_calls>\n<function_call><tool>Read</tool><args_json><![CDATA[${JSON.stringify({ file_path: filePath })}]]></args_json></function_call>\n</function_calls>`, { triggerSignal: trigger, tools });
  assert.equal(parsed.toolCalls.length, 1);
  assert.equal(JSON.parse(parsed.toolCalls[0].function.arguments).file_path, filePath);
});

test('parseXmlToolCallsFromText rejects invalid XML tool calls', () => {
  const trigger = '<Function_AB12_Start/>';
  assert.equal(parseXmlToolCallsFromText(`${trigger}\n<function_calls><function_call><tool>Read</tool></function_call></function_calls>`, { triggerSignal: trigger, tools }), null);
  assert.equal(parseXmlToolCallsFromText(`${trigger}\n<function_calls><function_call><tool>Read</tool><args_json>x<![CDATA[{"file_path":"a"}]]>y</args_json></function_call></function_calls>`, { triggerSignal: trigger, tools }), null);
  assert.equal(parseXmlToolCallsFromText(`${trigger}\n<function_calls><function_call><tool>Read</tool><args_json>[]</args_json></function_call></function_calls>`, { triggerSignal: trigger, tools }), null);
  assert.equal(parseXmlToolCallsFromText(`${trigger}\n<function_calls><function_call><tool>Write</tool><args_json>{}</args_json></function_call></function_calls>`, { triggerSignal: trigger, tools }), null);
  assert.equal(parseXmlToolCallsFromText(`${trigger}\n<function_calls><function_call><tool>Read</tool><args_json>{}</args_json></function_call></function_calls>`, { triggerSignal: trigger, tools, toolChoice: { type: 'function', function: { name: 'Write' } } }), null);
});

test('parseToolCallsDetailed returns schema_error details', () => {
  const trigger = '<Function_AB12_Start/>';
  const plan = createPromptPlan({ req: rawReq({ messages: [{ role: 'user', content: 'hi' }] }), tools, toolChoice: 'auto' });
  const result = plan.parseToolCallsDetailed(`${plan.triggerSignal}\n<function_calls><function_call><tool>Read</tool><args_json>{}</args_json></function_call></function_calls>`);
  assert.equal(result.toolCalls, null);
  assert.equal(result.failureType, 'schema_error');
  assert.match(result.errorDetails, /missing required property 'file_path'/);

  const explicit = parseXmlToolCallsFromText(`${trigger}\n<function_calls><function_call><tool>Read</tool><args_json>{}</args_json></function_call></function_calls>`, { triggerSignal: trigger, tools });
  assert.equal(explicit, null);
});

test('parseXmlToolCallsFromText ignores trigger inside think and uses last valid trigger', () => {
  const trigger = '<Function_AB12_Start/>';
  const text = `<think>${trigger}\n<function_calls><function_call><tool>Read</tool><args_json>{"file_path":"bad"}</args_json></function_call></function_calls></think>\n${trigger}\n<function_calls><function_call><tool>Read</tool><args_json>{"file_path":"good"}</args_json></function_call></function_calls>`;
  const parsed = parseXmlToolCallsFromText(text, { triggerSignal: trigger, tools });
  assert.equal(JSON.parse(parsed.toolCalls[0].function.arguments).file_path, 'good');
});

test('parseXmlToolCallsFromText does not parse old JSON pseudo-tool output', () => {
  const parsed = parseXmlToolCallsFromText('{"assistant_response":null,"tool_calls":[{"name":"Read","arguments":{"file_path":"a"}}]}', {
    triggerSignal: '<Function_AB12_Start/>',
    tools,
  });
  assert.equal(parsed, null);
});

test('parseXmlToolCallsFromText rejects trailing text after function_calls', () => {
  const trigger = '<Function_AB12_Start/>';
  const parsed = parseXmlToolCallsFromText(`${trigger}\n<function_calls><function_call><tool>Read</tool><args_json>{"file_path":"a"}</args_json></function_call></function_calls> trailing explanation`, {
    triggerSignal: trigger,
    tools,
  });
  assert.equal(parsed, null);
});

test('parseXmlToolCallsFromText rejects malformed extra content inside function_calls', () => {
  const trigger = '<Function_AB12_Start/>';
  const parsed = parseXmlToolCallsFromText(`${trigger}\n<function_calls><function_call><tool>Read</tool><args_json>{"file_path":"a"}</args_json></function_call><function_call><tool>Read</tool></function_calls>`, {
    triggerSignal: trigger,
    tools,
  });
  assert.equal(parsed, null);
});

test('parseXmlToolCallsFromText ignores trigger inside think tags with attributes', () => {
  const trigger = '<Function_AB12_Start/>';
  const text = `<THINK hidden>${trigger}\n<function_calls><function_call><tool>Read</tool><args_json>{"file_path":"bad"}</args_json></function_call></function_calls></THINK>\n${trigger}\n<function_calls><function_call><tool>Read</tool><args_json>{"file_path":"good"}</args_json></function_call></function_calls>`;
  const parsed = parseXmlToolCallsFromText(text, { triggerSignal: trigger, tools });
  assert.equal(JSON.parse(parsed.toolCalls[0].function.arguments).file_path, 'good');
});

test('XML stream detector handles split trigger and returns tool calls', () => {
  const trigger = '<Function_AB12_Start/>';
  const parseToolCalls = (text) => parseXmlToolCallsFromText(text, { triggerSignal: trigger, tools });
  const detector = createXmlToolCallDetector({ triggerSignal: trigger, parseToolCalls });

  assert.equal(detector.process('hello ').delta, 'hello ');
  assert.equal(detector.process('<Function_').delta, '');
  assert.equal(detector.process('AB12_Start/>\n<function_calls>').delta, '');
  const result = detector.process('<function_call><tool>Read</tool><args_json>{"file_path":"a"}</args_json></function_call></function_calls>');
  assert.equal(result.completed, true);
  assert.equal(result.toolCalls[0].function.name, 'Read');
});

test('production XML stream detector buffers split trigger before function_calls', () => {
  const plan = createPromptPlan({ req: rawReq({ messages: [] }), tools });
  const detector = plan.createStreamDetector();
  assert.equal(detector.process(plan.triggerSignal).delta, '');
  assert.equal(detector.process('\n<function_calls>').delta, '');
  const result = detector.process('<function_call><tool>Read</tool><args_json>{"file_path":"a"}</args_json></function_call></function_calls>');
  assert.equal(result.completed, true);
  assert.equal(result.toolCalls[0].function.name, 'Read');
});

test('production XML stream detector buffers split function_calls tag with attributes', () => {
  const plan = createPromptPlan({ req: rawReq({ messages: [] }), tools });
  const detector = plan.createStreamDetector();
  assert.equal(detector.process(`${plan.triggerSignal}\n<function_calls `).delta, '');
  assert.equal(detector.process('data-x="1">').delta, '');
  const result = detector.process('<function_call><tool>Read</tool><args_json>{"file_path":"a"}</args_json></function_call></function_calls>');
  assert.equal(result.completed, true);
  assert.equal(result.toolCalls[0].function.name, 'Read');
});

test('XML stream detector ignores split think tags with attributes', () => {
  const plan = createPromptPlan({ req: rawReq({ messages: [] }), tools });
  const detector = plan.createStreamDetector();
  assert.equal(detector.process('<TH').delta, '');
  assert.equal(detector.process(`INK hidden>${plan.triggerSignal}\n<function_calls><function_call><tool>Read</tool><args_json>{"file_path":"bad"}</args_json></function_call></function_calls>`).delta.includes(plan.triggerSignal), true);
  assert.equal(detector.process('</TH').delta, '');
  assert.equal(detector.process('INK>').delta, '</THINK>');
  const result = detector.process(`${plan.triggerSignal}\n<function_calls><function_call><tool>Read</tool><args_json>{"file_path":"good"}</args_json></function_call></function_calls>`);
  assert.equal(result.completed, true);
  assert.equal(JSON.parse(result.toolCalls[0].function.arguments).file_path, 'good');
});

test('production XML stream detector emits valid tool calls immediately', () => {
  const plan = createPromptPlan({ req: rawReq({ messages: [] }), tools });
  const detector = plan.createStreamDetector();
  const text = `${plan.triggerSignal}\n<function_calls><function_call><tool>Read</tool><args_json>{"file_path":"a"}</args_json></function_call></function_calls>`;
  const initial = detector.process(text);
  assert.equal(initial.completed, true);
  assert.equal(initial.delta, '');
  assert.equal(initial.toolCalls[0].function.name, 'Read');
  assert.equal(detector.finish().delta, '');
});

test('XML stream detector leaves old JSON pseudo-tool output as text', () => {
  const trigger = '<Function_AB12_Start/>';
  const detector = createXmlToolCallDetector({
    triggerSignal: trigger,
    parseToolCalls: (text) => parseXmlToolCallsFromText(text, { triggerSignal: trigger, tools }),
  });
  const text = '{"assistant_response":null,"tool_calls":[{"name":"Read","arguments":{}}]}';
  assert.equal(detector.process(text).delta, text);
  assert.equal(detector.finish().delta, '');
});

test('XML stream detector falls back to text when XML has trailing explanation', () => {
  const trigger = '<Function_AB12_Start/>';
  const detector = createXmlToolCallDetector({
    triggerSignal: trigger,
    parseToolCalls: (text) => parseXmlToolCallsFromText(text, { triggerSignal: trigger, tools }),
  });
  const text = `${trigger}\n<function_calls><function_call><tool>Read</tool><args_json>{"file_path":"a"}</args_json></function_call></function_calls> trailing explanation`;
  assert.equal(detector.process(text).delta, text);
  const finished = detector.finish();
  assert.equal(finished.completed, undefined);
  assert.equal(finished.delta, '');
});

test('XML stream detector reports parse failure with buffered text and fallback delta', () => {
  const trigger = '<Function_AB12_Start/>';
  const detector = createXmlToolCallDetector({
    triggerSignal: trigger,
    parseToolCalls: (text) => parseXmlToolCallsFromText(text, { triggerSignal: trigger, tools }),
    parseToolCallsDetailed: (text) => parseXmlToolCallsDetailed(text, { triggerSignal: trigger, tools }),
  });
  const text = `${trigger}\n<function_calls><function_call><tool>Read</tool><args_json>{}</args_json></function_call></function_calls>`;
  const processed = detector.process(text);
  assert.equal(processed.parseFailure, true);
  assert.equal(processed.bufferedToolText, text);
  assert.equal(processed.failureType, 'schema_error');
  assert.match(processed.errorDetails, /missing required property 'file_path'/);
  assert.equal(processed.delta, text);
  assert.equal(detector.process(' later text').delta, ' later text');

  const finished = detector.finish();
  assert.equal(finished.parseFailure, undefined);
  assert.equal(finished.delta, '');
});

test('production XML stream detector reports parse failure and does not swallow later chunks', () => {
  const plan = createPromptPlan({ req: rawReq({ messages: [] }), tools });
  const detector = plan.createStreamDetector();
  const text = `${plan.triggerSignal}\n<function_calls><function_call><tool>Read</tool><args_json>{}</args_json></function_call></function_calls>`;
  const processed = detector.process(text);
  assert.equal(processed.parseFailure, true);
  assert.equal(processed.bufferedToolText, text);
  assert.equal(processed.failureType, 'schema_error');
  assert.equal(processed.delta, text);
  assert.equal(detector.process(' later text').delta, ' later text');
  assert.equal(detector.finish().delta, '');
});

test('production XML stream detector reports trailing explanation failure with fallback text', () => {
  const plan = createPromptPlan({ req: rawReq({ messages: [] }), tools });
  const detector = plan.createStreamDetector();
  const text = `${plan.triggerSignal}\n<function_calls><function_call><tool>Read</tool><args_json>{"file_path":"a"}</args_json></function_call></function_calls> trailing explanation`;
  const processed = detector.process(text);
  assert.equal(processed.parseFailure, true);
  assert.equal(processed.failureType, 'syntax_error');
  assert.match(processed.errorDetails, /Unexpected text after/);
  assert.equal(processed.delta, text);
  assert.equal(detector.process(' later text').delta, ' later text');
});

test('production XML stream detector completes valid tool call before later chunks', () => {
  const plan = createPromptPlan({ req: rawReq({ messages: [] }), tools });
  const detector = plan.createStreamDetector();
  const text = `${plan.triggerSignal}\n<function_calls><function_call><tool>Read</tool><args_json>{"file_path":"a"}</args_json></function_call></function_calls>`;
  const initial = detector.process(text);
  assert.equal(initial.completed, true);
  assert.equal(initial.delta, '');
  assert.equal(initial.toolCalls[0].function.name, 'Read');

  assert.equal(detector.process(' trailing explanation').delta, '');
});

test('XML stream detector reports truncated buffered tool text on finish', () => {
  const plan = createPromptPlan({ req: rawReq({ messages: [] }), tools });
  const detector = plan.createStreamDetector();
  const text = `${plan.triggerSignal}\n<function_calls><function_call><tool>Read</tool><args_json>{"file_path":"a"}`;
  assert.equal(detector.process(text).delta, '');
  const finished = detector.finish();
  assert.equal(finished.parseFailure, true);
  assert.equal(finished.bufferedToolText, text);
  assert.equal(finished.failureType, 'truncated');
  assert.equal(finished.delta, text);
});
