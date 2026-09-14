import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildXmlToolInstructions,
  createPromptPlan,
  createXmlToolCallDetector,
  detectFileMutationTools,
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
    omni: {
      promptInjectionEnabled: true,
      rawRequestJsonText: JSON.stringify(body),
      ...(overrides.omni || {}),
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
  assert.match(required, /必须调用至少一个工具/);

  const specific = buildXmlToolInstructions({
    tools,
    toolChoice: { type: 'function', function: { name: 'Read' } },
    triggerSignal: '<Function_AB12_Start/>',
  });
  assert.match(specific, /只能调用 `Read` 这一个工具/);
});

const editTool = {
  type: 'function',
  function: {
    name: 'Edit',
    description: 'Replace a string in a file',
    parameters: {
      type: 'object',
      properties: {
        file_path: { type: 'string' },
        old_string: { type: 'string' },
        new_string: { type: 'string' },
      },
      required: ['file_path', 'old_string', 'new_string'],
    },
  },
};

const writeTool = {
  type: 'function',
  function: {
    name: 'Write',
    description: 'Write a file to disk',
    parameters: {
      type: 'object',
      properties: {
        file_path: { type: 'string' },
        content: { type: 'string' },
      },
      required: ['file_path', 'content'],
    },
  },
};

test('detectFileMutationTools classifies edit-like and write-like tools by name and params', () => {
  const { editNames, writeNames } = detectFileMutationTools([
    ...tools,
    editTool,
    writeTool,
    { type: 'function', function: { name: 'NotebookEdit', parameters: { type: 'object', properties: { notebook_path: { type: 'string' }, new_source: { type: 'string' } } } } },
    { type: 'function', function: { name: 'apply_patch', parameters: { type: 'object', properties: { patch: { type: 'string' } } } } },
    { type: 'function', function: { name: 'Bash', parameters: { type: 'object', properties: { command: { type: 'string' } } } } },
    // 名字含 patch 子串但不是编辑工具，精确匹配不应误判
    { type: 'function', function: { name: 'DispatchEvent', parameters: { type: 'object', properties: { event: { type: 'string' } } } } },
  ]);
  assert.deepEqual(editNames, ['Edit', 'NotebookEdit', 'apply_patch']);
  assert.deepEqual(writeNames, ['Write']);
});

test('edit-first hard rules are injected only when edit and write tools coexist', () => {
  const both = buildXmlToolInstructions({ tools: [...tools, editTool, writeTool], toolChoice: 'auto', triggerSignal: '<Function_AB12_Start/>' });
  assert.match(both, /文件修改工具选择（硬规则/);
  assert.match(both, /必须用 Edit 做精确替换，禁止用 Write 整文件重写/);
  assert.match(both, /Write 仅限两种场景/);
  assert.match(both, /编辑铁律/);
  assert.match(both, /调用 Write 前自检两问/);
  // 上游能力放开后不再注入"次数/字数/分段"类硬限制
  assert.doesNotMatch(both, /大内容分段写入协议/);
  assert.doesNotMatch(both, /超过约 200 行/);
  assert.doesNotMatch(both, /每轮最多/);

  // 只有 Read：不注入任何文件修改选择规则
  const readOnly = buildXmlToolInstructions({ tools, toolChoice: 'auto', triggerSignal: '<Function_AB12_Start/>' });
  assert.doesNotMatch(readOnly, /文件修改工具选择/);
  assert.doesNotMatch(readOnly, /编辑铁律/);
  assert.doesNotMatch(readOnly, /分段写入协议/);

  // 只有 Write（客户端未暴露编辑工具）：不得禁止 Write 改文件，改为覆盖安全规则
  const writeOnly = buildXmlToolInstructions({ tools: [...tools, writeTool], toolChoice: 'auto', triggerSignal: '<Function_AB12_Start/>' });
  assert.doesNotMatch(writeOnly, /文件修改工具选择（硬规则/);
  assert.doesNotMatch(writeOnly, /编辑铁律/);
  assert.doesNotMatch(writeOnly, /分段写入协议/);
  assert.match(writeOnly, /覆盖已有文件前必须先 Read 其完整内容/);

  // 只有编辑工具（Codex apply_patch 类）：只提示精确修改
  const editOnly = buildXmlToolInstructions({ tools: [...tools, editTool], toolChoice: 'auto', triggerSignal: '<Function_AB12_Start/>' });
  assert.doesNotMatch(editOnly, /编辑铁律/);
  assert.match(editOnly, /修改文件一律用 Edit 做精确修改/);
  assert.match(editOnly, /只提交需要变更的片段/);
});

test('createPromptPlan disables injection using raw JSON prompt', () => {
  const body = {
    model: 'deepseek-flash',
    messages: [
      { role: 'system', content: 'be precise' },
      { role: 'user', content: 'hello' },
    ],
    tools,
    tool_choice: 'required',
  };
  const raw = JSON.stringify(body);
  const plan = createPromptPlan({
    req: rawReq(body, { omni: { promptInjectionEnabled: false, rawRequestJsonText: raw } }),
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

test('createPromptPlan disables tool injection for title-generation requests', () => {
  const body = {
    model: 'deepseek-flash',
    system: 'Generate a concise title (3-7 words) for this coding session. Return JSON: {"title": "..."}',
    messages: [{ role: 'user', content: '分析本项目' }],
    tools,
    tool_choice: 'auto',
  };
  const plan = createPromptPlan({
    req: rawReq(body),
    tools,
    toolChoice: 'auto',
  });
  assert.equal(plan.promptInjectionDisabled, true);
  assert.deepEqual(plan.tools, []);
  assert.equal(plan.toolChoice, 'none');
  assert.equal(plan.toolCallingEnabled, false);
  assert.equal(plan.triggerSignal, null);
  assert.equal(plan.toolInstructions, '');
  assert.equal(plan.parseToolCalls('anything'), null);
  assert.equal(plan.createStreamDetector(), null);
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

const bareTools = [
  ...tools,
  {
    type: 'function',
    function: {
      name: 'Grep',
      description: 'Search file contents',
      parameters: {
        type: 'object',
        properties: {
          pattern: { type: 'string' },
          path: { type: 'string' },
          output_mode: { type: 'string' },
          '-n': { type: 'boolean' },
        },
        required: ['pattern'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'Glob',
      description: 'Find files by glob pattern',
      parameters: {
        type: 'object',
        properties: {
          pattern: { type: 'string' },
          path: { type: 'string' },
        },
        required: ['pattern'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'ApplyPatch',
      description: 'Apply a unified diff patch',
      parameters: {
        type: 'object',
        properties: {
          patch: { type: 'string' },
        },
        required: ['patch'],
      },
    },
  },
];

test('parseXmlToolCallsDetailed parses bare function_calls without trigger signal', () => {
  const text = [
    '我来查一下项目暴露的所有 API 端点。',
    '',
    '<function_calls>',
    '<function_call>',
    '<tool>Grep</tool>',
    '<args_json><![CDATA[{"pattern":"router\\\\.(get|post|put|delete|patch)","path":"src/routes","output_mode":"content","-n":true}]]></args_json>',
    '</function_call>',
    '<function_call>',
    '<tool>Read</tool>',
    '<args_json><![CDATA[{"file_path":"D:\\\\tools\\\\Any2api\\\\src\\\\routes\\\\api.js"}]]></args_json>',
    '</function_call>',
    '</function_calls>',
  ].join('\n');
  const result = parseXmlToolCallsDetailed(text, { triggerSignal: '<Function_AB12_Start/>', tools: bareTools });
  assert.equal(result.failureType, null);
  assert.equal(result.content, '我来查一下项目暴露的所有 API 端点。');
  assert.equal(result.toolCalls.length, 2);
  assert.equal(result.toolCalls[0].function.name, 'Grep');
  assert.equal(JSON.parse(result.toolCalls[0].function.arguments).pattern, 'router\\.(get|post|put|delete|patch)');
  assert.equal(JSON.parse(result.toolCalls[0].function.arguments)['-n'], true);
  assert.equal(result.toolCalls[1].function.name, 'Read');
  assert.equal(JSON.parse(result.toolCalls[1].function.arguments).file_path, 'D:\\tools\\Any2api\\src\\routes\\api.js');
});

test('parseXmlToolCallsDetailed reports truncated for incomplete bare function_calls', () => {
  const result = parseXmlToolCallsDetailed('前言\n<function_calls>\n<function_call><tool>Read</tool><args_json>{"file_path":"a"', { triggerSignal: '<Function_AB12_Start/>', tools });
  assert.equal(result.failureType, 'truncated');
  assert.equal(result.content, '前言');
});

test('parseXmlToolCallsDetailed reports syntax_error for malformed bare block args', () => {
  const result = parseXmlToolCallsDetailed('<function_calls><function_call><tool>Read</tool><args_json>not json</args_json></function_call></function_calls>', { triggerSignal: '<Function_AB12_Start/>', tools });
  assert.equal(result.failureType, 'syntax_error');
});

test('parseXmlToolCallsDetailed still returns no_fc without any function_calls block', () => {
  const result = parseXmlToolCallsDetailed('普通回复，没有工具调用。', { triggerSignal: '<Function_AB12_Start/>', tools });
  assert.equal(result.failureType, 'no_fc');
  assert.equal(result.content, '普通回复，没有工具调用。');
});

test('parseXmlToolCallsDetailed ignores bare function_calls inside think blocks', () => {
  const text = '<think><function_calls><function_call><tool>Read</tool><args_json>{"file_path":"bad"}</args_json></function_call></function_calls></think>正文回复';
  const result = parseXmlToolCallsDetailed(text, { triggerSignal: '<Function_AB12_Start/>', tools });
  assert.equal(result.failureType, 'no_fc');
  assert.equal(result.toolCalls, null);
});

test('bare fallback ignores function_calls text inside CDATA args', () => {
  const filePath = '/tmp/<function_calls><function_call></function_calls>.txt';
  const text = `<function_calls>\n<function_call><tool>Read</tool><args_json><![CDATA[${JSON.stringify({ file_path: filePath })}]]></args_json></function_call>\n</function_calls>`;
  const parsed = parseXmlToolCallsFromText(text, { triggerSignal: '<Function_AB12_Start/>', tools });
  assert.equal(parsed.toolCalls.length, 1);
  assert.equal(JSON.parse(parsed.toolCalls[0].function.arguments).file_path, filePath);
});

test('trigger signal path still takes precedence over bare fallback', () => {
  const trigger = '<Function_AB12_Start/>';
  const text = `${trigger}\n<function_calls><function_call><tool>Read</tool><args_json>{"file_path":"good"}</args_json></function_call></function_calls>`;
  const parsed = parseXmlToolCallsFromText(text, { triggerSignal: trigger, tools });
  assert.equal(JSON.parse(parsed.toolCalls[0].function.arguments).file_path, 'good');
});

test('XML stream detector detects bare function_calls without trigger signal', () => {
  const plan = createPromptPlan({ req: rawReq({ messages: [] }), tools });
  const detector = plan.createStreamDetector();
  assert.equal(detector.process('我来读取文件。').delta, '我来读取文件。');
  assert.equal(detector.process('<function_').delta, '');
  assert.equal(detector.process('calls>\n<function_call><tool>Read</tool>').delta, '');
  const result = detector.process('<args_json>{"file_path":"a"}</args_json></function_call></function_calls>');
  assert.equal(result.completed, true);
  assert.equal(result.toolCalls[0].function.name, 'Read');
  assert.equal(JSON.parse(result.toolCalls[0].function.arguments).file_path, 'a');
});

test('XML stream detector reports truncated bare function_calls on finish', () => {
  const plan = createPromptPlan({ req: rawReq({ messages: [] }), tools });
  const detector = plan.createStreamDetector();
  const text = '<function_calls><function_call><tool>Read</tool><args_json>{"file_path":"a"';
  assert.equal(detector.process(text).delta, '');
  const finished = detector.finish();
  assert.equal(finished.parseFailure, true);
  assert.equal(finished.bufferedToolText, text);
  assert.equal(finished.failureType, 'truncated');
  assert.equal(finished.delta, text);
});

test('XML stream detector reports bare block schema failure without permanent buffering', () => {
  const plan = createPromptPlan({ req: rawReq({ messages: [] }), tools });
  const detector = plan.createStreamDetector();
  const text = '<function_calls><function_call><tool>Read</tool><args_json>{}</args_json></function_call></function_calls>';
  const processed = detector.process(text);
  assert.equal(processed.parseFailure, true);
  assert.equal(processed.failureType, 'schema_error');
  assert.equal(processed.delta, text);
  assert.equal(detector.process(' later').delta, ' later');
});

test('parseArgsJson repairs literal newlines inside JSON string values', () => {
  const editTools = [{
    type: 'function',
    function: {
      name: 'Edit',
      description: 'edit file',
      parameters: {
        type: 'object',
        properties: {
          file_path: { type: 'string' },
          old_string: { type: 'string' },
          new_string: { type: 'string' },
        },
        required: ['file_path', 'old_string', 'new_string'],
      },
    },
  }];
  const trigger = '<Function_AB12_Start/>';
  // 模型输出多行 new_string 时经常直接换行——严格 JSON 非法，应被修复兜底救回
  const argsWithLiteralNewline = '{"file_path":"a.js","old_string":"foo","new_string":"line1\nline2\n\tindented"}';
  const parsed = parseXmlToolCallsFromText(
    `${trigger}\n<function_calls><function_call><tool>Edit</tool><args_json><![CDATA[${argsWithLiteralNewline}]]></args_json></function_call></function_calls>`,
    { triggerSignal: trigger, tools: editTools },
  );
  assert.equal(parsed.toolCalls.length, 1);
  assert.equal(JSON.parse(parsed.toolCalls[0].function.arguments).new_string, 'line1\nline2\n\tindented');
});

test('parseArgsJson repairs invalid Windows path escapes', () => {
  const trigger = '<Function_AB12_Start/>';
  // CDATA 内是未双写的 Windows 路径：\U、\x 均非合法 JSON 转义
  const parsed = parseXmlToolCallsFromText(
    `${trigger}\n<function_calls><function_call><tool>Read</tool><args_json><![CDATA[{"file_path":"C:\\Users\\x.js"}]]></args_json></function_call></function_calls>`,
    { triggerSignal: trigger, tools },
  );
  assert.equal(parsed.toolCalls.length, 1);
  assert.equal(JSON.parse(parsed.toolCalls[0].function.arguments).file_path, 'C:\\Users\\x.js');
});

const editToolsWithReplaceAll = [{
  type: 'function',
  function: {
    name: 'Edit',
    description: 'edit file',
    parameters: {
      type: 'object',
      properties: {
        file_path: { type: 'string' },
        old_string: { type: 'string' },
        new_string: { type: 'string' },
        replace_all: { type: 'boolean' },
      },
      required: ['file_path', 'old_string', 'new_string'],
    },
  },
}];

test('parseArgsJson repairs premature CDATA-close hallucination inside JSON', () => {
  const trigger = '<Function_AB12_Start/>';
  // 真实案例：模型写完 new_string 后误输出 "}]] 提前闭合，又想起 replace_all
  // 没写，接着输出 , "replace_all": false}} 才真正闭合 CDATA
  const brokenArgs = '{"file_path":"D:\\\\tools\\\\test\\\\server.js","old_string":"let db = null;","new_string":"let db = null;  // 全局数据库实例"}]], "replace_all": false}}';
  const parsed = parseXmlToolCallsFromText(
    `${trigger}\n<function_calls><function_call><tool>Edit</tool><args_json><![CDATA[${brokenArgs}]]></args_json></function_call></function_calls>`,
    { triggerSignal: trigger, tools: editToolsWithReplaceAll },
  );
  assert.equal(parsed.toolCalls.length, 1);
  const args = JSON.parse(parsed.toolCalls[0].function.arguments);
  assert.equal(args.file_path, 'D:\\tools\\test\\server.js');
  assert.equal(args.old_string, 'let db = null;');
  assert.match(args.new_string, /全局数据库实例/);
  assert.equal(args.replace_all, false);
});

test('parseArgsJson merges params leaked outside a prematurely closed CDATA', () => {
  const trigger = '<Function_AB12_Start/>';
  // 变体：模型在 JSON 中途输出了完整 ]]>，CDATA 真的提前终止，
  // 剩余参数泄漏到 CDATA 外，最后又补了一个 ]]>
  const parsed = parseXmlToolCallsFromText(
    `${trigger}\n<function_calls><function_call><tool>Edit</tool><args_json><![CDATA[{"file_path":"a.js","old_string":"x","new_string":"y"}]]>, "replace_all": false}}]]></args_json></function_call></function_calls>`,
    { triggerSignal: trigger, tools: editToolsWithReplaceAll },
  );
  assert.equal(parsed.toolCalls.length, 1);
  const args = JSON.parse(parsed.toolCalls[0].function.arguments);
  assert.equal(args.file_path, 'a.js');
  assert.equal(args.new_string, 'y');
  assert.equal(args.replace_all, false);
});

test('stray-closer repair does not touch valid nested arrays', () => {
  const trigger = '<Function_AB12_Start/>';
  const matrixTools = [{
    type: 'function',
    function: {
      name: 'Data',
      description: 'data tool',
      parameters: {
        type: 'object',
        properties: { matrix: { type: 'array' } },
        required: ['matrix'],
      },
    },
  }];
  const parsed = parseXmlToolCallsFromText(
    `${trigger}\n<function_calls><function_call><tool>Data</tool><args_json><![CDATA[{"matrix":[[1,2],[3,4]]}]]></args_json></function_call></function_calls>`,
    { triggerSignal: trigger, tools: matrixTools },
  );
  assert.equal(parsed.toolCalls.length, 1);
  assert.deepEqual(JSON.parse(parsed.toolCalls[0].function.arguments).matrix, [[1, 2], [3, 4]]);
});

test('XML instructions carry JSON escaping rules and continuation guidance', () => {
  const instructions = buildXmlToolInstructions({ tools, toolChoice: 'auto', triggerSignal: '<Function_AB12_Start/>' });
  assert.match(instructions, /禁止在 JSON 字符串里直接换行|字符串内的换行必须写成/);
  assert.match(instructions, /反斜杠必须双写/);
  assert.match(instructions, /不输出触发信号直接输出.*延迟/);
  assert.match(instructions, /修复后重新运行测试/);
  assert.match(instructions, /任务全部完成后/);
  assert.match(instructions, /修改完成后主动验证/);
  assert.match(instructions, /说了要做，就必须当场调用|将使用\/需要某工具/);
  // 上游能力放开后不再对单次回复的工具调用数量设上限
  assert.doesNotMatch(instructions, /单次回复最多\s*\d+\s*个/);
  assert.doesNotMatch(instructions, /最多只有\s*\d+\s*个/);
  // 工具集中不存在的编辑/写入工具名不得被推荐（只读工具集不应出现 MultiEdit）
  assert.doesNotMatch(instructions, /MultiEdit/);
  assert.match(instructions, /正在启动|我先读取/);
  assert.match(instructions, /工具定义里没有的字段|description\/comment\/note\/justification/);
  assert.match(instructions, /探索项目|我先读取项目/);
  assert.match(instructions, /伪代码/);
  assert.match(instructions, /\[调用 工具名\]/);
  assert.match(instructions, /Action\/Action Input/);
  assert.doesNotMatch(instructions, /不要再重复调用相同的工具/);
});

test('XML instructions comprehensively cover known tool-call failure modes', () => {
  const instructions = buildXmlToolInstructions({ tools, toolChoice: 'auto', triggerSignal: '<Function_AB12_Start/>' });

  // 强制决策 + 自检清单
  assert.match(instructions, /工具调用决策（强制）/);
  assert.match(instructions, /发送前自检清单/);
  assert.match(instructions, /唯一合法格式/);
  assert.match(instructions, /一句话铁律|只写计划 = 任务死锁/);

  // A. 只写计划不输出 XML
  assert.match(instructions, /只写计划、不输出 XML/);
  assert.match(instructions, /好的，我先读取项目的关键文档/);
  assert.match(instructions, /我来帮你全面分析这个项目/);
  assert.match(instructions, /我们先获取设置页完整代码/);
  assert.match(instructions, /我来读取设置页面主代码和主题相关文件/);
  assert.match(instructions, /我先看看项目结构再决定怎么做/);
  assert.match(instructions, /我先确认一下优化范围/);

  // B. 结构残缺 / CDATA / JSON
  assert.match(instructions, /结构残缺 \/ 标签错误/);
  assert.match(instructions, /只有 `<tool>shell_command<\/tool>`/);
  assert.match(instructions, /CDATA 结束写成 `]>`/);
  assert.match(instructions, /JSON 末尾漏 `}`/);
  assert.match(instructions, /ASCII 双引号夹词/);
  assert.match(instructions, /触发信号写错/);
  assert.match(instructions, /<\/function_calls>` 后还有解释文字/);

  // C. schema 越界
  assert.match(instructions, /参数 \/ schema 越界/);
  assert.match(instructions, /options 写了 5 个选项/);
  assert.match(instructions, /maxItems=4/);
  assert.match(instructions, /description \/ comment \/ note \/ justification/);
  assert.match(instructions, /command 写成数组/);

  // 正确示例含当前触发信号
  assert.match(instructions, /<Function_AB12_Start\/>/);
  assert.match(instructions, /正确完整示例/);
  assert.match(instructions, /同一意图的正确写法/);
});

test('XML instructions inject interactive tool rules when AskUserQuestion is present', () => {
  const interactiveTools = [
    ...tools,
    {
      type: 'function',
      function: {
        name: 'AskUserQuestion',
        description: 'Ask the user a question',
        parameters: {
          type: 'object',
          properties: {
            questions: { type: 'array' },
          },
          required: ['questions'],
        },
      },
    },
  ];
  const instructions = buildXmlToolInstructions({ tools: interactiveTools, toolChoice: 'auto', triggerSignal: '<Function_AB12_Start/>' });
  assert.match(instructions, /交互\/询问工具规则/);
  assert.match(instructions, /AskUserQuestion/);
  assert.match(instructions, /客户端只识别工具调用格式的提问/);
  assert.match(instructions, /客户端会直接断开/);
  assert.match(instructions, /options 数量必须在 2–4 个之间/);
  assert.match(instructions, /header 尽量短/);
  assert.match(instructions, /multiSelect 必须是布尔值/);
  // 非交互工具集不应注入交互规则
  assert.doesNotMatch(buildXmlToolInstructions({ tools, toolChoice: 'auto', triggerSignal: '<Function_AB12_Start/>' }), /交互\/询问工具规则/);
});

test('pseudo-code tool calls with schema violations trigger schema_error retry', () => {
  // 用户报告的实际场景：已知工具名但参数错误 + 幻觉工具名
  const text = '我来分析一下这个项目的结构、技术栈和当前状态。\nGrep({"glob_pattern": "**/*", "target_directory": "d:\\\\project"})\nReadFile({"path": "d:\\\\project\\\\README.md"})';
  const result = parseXmlToolCallsDetailed(text, { triggerSignal: '<Function_AB12_Start/>', tools: bareTools });
  assert.equal(result.toolCalls, null);
  assert.equal(result.failureType, 'schema_error');
  assert.match(result.errorDetails, /伪代码格式/);
  assert.match(result.errorDetails, /<function_calls>/);
  assert.equal(result.content, '我来分析一下这个项目的结构、技术栈和当前状态。');
});

test('valid pseudo-code tool calls are executed directly with prefix content', () => {
  const text = '先搜索路由定义。\nGrep({"pattern": "router"})\nRead({"file_path": "D:\\\\repo\\\\a.js"})';
  const result = parseXmlToolCallsDetailed(text, { triggerSignal: '<Function_AB12_Start/>', tools: bareTools });
  assert.equal(result.failureType, null);
  assert.equal(result.content, '先搜索路由定义。');
  assert.equal(result.toolCalls.length, 2);
  assert.equal(result.toolCalls[0].function.name, 'Grep');
  assert.equal(JSON.parse(result.toolCalls[0].function.arguments).pattern, 'router');
  assert.equal(result.toolCalls[1].function.name, 'Read');
});

test('bracket pseudo tool calls are executed directly with prefix content', () => {
  const text = '我来分析一下 `D:\\tools\\test` 这个项目。首先看一下根目录有哪些文件。\n\n[调用 Glob] {"pattern":"*","path":"D:\\\\tools\\\\test"}';
  const result = parseXmlToolCallsDetailed(text, { triggerSignal: '<Function_AB12_Start/>', tools: bareTools });
  assert.equal(result.failureType, null);
  assert.equal(result.content, '我来分析一下 `D:\\tools\\test` 这个项目。首先看一下根目录有哪些文件。');
  assert.equal(result.toolCalls.length, 1);
  assert.equal(result.toolCalls[0].function.name, 'Glob');
  assert.deepEqual(JSON.parse(result.toolCalls[0].function.arguments), { pattern: '*', path: 'D:\\tools\\test' });
});

test('transcript leaked function_call items are executed directly with prefix content', () => {
  const shellTools = [{
    type: 'function',
    function: {
      name: 'shell_command',
      parameters: {
        type: 'object',
        properties: { command: { type: 'string' } },
        required: ['command'],
      },
    },
  }];
  const text = [
    '我来全面探索项目结构，分析这是什么项目。',
    '',
    '[User]: {"type":"function_call","name":"shell_command","arguments":"{\\"command\\":\\"Get-ChildItem -Force -LiteralPath \'D:\\\\tools\\\\ting13\\\\android-app\\\\app\\\\src\\\\main\\\\kotlin\' -Recurse -Depth 3 | Select-Object -ExpandProperty FullName\\"}","call_id":"call_mrfzsuok_lnzlvsph"}',
    '',
    '[User]: {"type":"function_call","name":"shell_command","arguments":"{\\"command\\":\\"Get-Content -LiteralPath \'D:\\\\tools\\\\ting13\\\\README.md\' -Encoding GBK -Raw\\"}","call_id":"call_mrfzsuok_glx1tg18"}',
  ].join('\n');
  const result = parseXmlToolCallsDetailed(text, { triggerSignal: '<Function_AB12_Start/>', tools: shellTools });
  assert.equal(result.failureType, null);
  assert.equal(result.content, '我来全面探索项目结构，分析这是什么项目。');
  assert.equal(result.toolCalls.length, 2);
  assert.equal(result.toolCalls[0].id, 'call_mrfzsuok_lnzlvsph');
  assert.equal(result.toolCalls[0].function.name, 'shell_command');
  assert.match(JSON.parse(result.toolCalls[0].function.arguments).command, /Get-ChildItem -Force/);
  assert.equal(result.toolCalls[1].id, 'call_mrfzsuok_glx1tg18');
  assert.match(JSON.parse(result.toolCalls[1].function.arguments).command, /README\.md/);
});

test('bracket pseudo tool calls with schema violations trigger retry without leaking call text', () => {
  const text = '我来搜索。\n[调用 Glob] {"path":"D:\\\\tools\\\\test"}';
  const result = parseXmlToolCallsDetailed(text, { triggerSignal: '<Function_AB12_Start/>', tools: bareTools });
  assert.equal(result.toolCalls, null);
  assert.equal(result.content, '我来搜索。');
  assert.equal(result.failureType, 'schema_error');
  assert.match(result.errorDetails, /日志式工具调用/);
  assert.match(result.errorDetails, /<function_calls>/);
  assert.doesNotMatch(result.content || '', /\[调用 Glob\]/);
});

test('pseudo-code detection normalizes case-insensitive tool names', () => {
  const result = parseXmlToolCallsDetailed('read({"file_path": "a.js"})', { triggerSignal: '<Function_AB12_Start/>', tools });
  assert.equal(result.failureType, null);
  assert.equal(result.toolCalls[0].function.name, 'Read');
});

test('pseudo-code detection stays inactive without any known tool name', () => {
  const text = '示例代码：\nfetchData({"url": "https://example.com"})\nprocessResult({"mode": "fast"})';
  const result = parseXmlToolCallsDetailed(text, { triggerSignal: '<Function_AB12_Start/>', tools });
  assert.equal(result.failureType, 'no_fc');
  assert.equal(result.toolCalls, null);
});

test('pseudo-code detection ignores non-JSON arguments and mid-line mentions', () => {
  // JS 风格未加引号的 key 不是合法 JSON —— 不应激活
  const codeSample = 'Read({file_path: unquoted})';
  assert.equal(parseXmlToolCallsDetailed(codeSample, { triggerSignal: '<Function_AB12_Start/>', tools }).failureType, 'no_fc');
  // 行中提及（非行首）不应激活
  const midLine = '你可以用 Read({"file_path": "a.js"}) 这样的方式读取文件';
  assert.equal(parseXmlToolCallsDetailed(midLine, { triggerSignal: '<Function_AB12_Start/>', tools }).failureType, 'no_fc');
});

test('non-standard ApplyPatch XML is converted to ApplyPatch tool call when available', () => {
  const text = [
    '以下是修改后的完整文档。',
    '',
    '<ApplyPatch>',
    '  <patch><![CDATA[*** Begin Patch',
    '*** Update File: d:\\project\\good-ide\\README.md',
    '@@',
    '-old',
    '+new',
    '*** End Patch]]></patch>',
    '</ApplyPatch>',
  ].join('\n');
  const result = parseXmlToolCallsDetailed(text, { triggerSignal: '<Function_AB12_Start/>', tools: bareTools });
  assert.equal(result.failureType, null);
  assert.equal(result.content, '以下是修改后的完整文档。');
  assert.equal(result.toolCalls.length, 1);
  assert.equal(result.toolCalls[0].function.name, 'ApplyPatch');
  const args = JSON.parse(result.toolCalls[0].function.arguments);
  assert.match(args.patch, /\*\*\* Begin Patch/);
  assert.match(args.patch, /Update File: d:\\project\\good-ide\\README\.md/);
});

test('non-standard ApplyPatch XML triggers retry when ApplyPatch tool is unavailable', () => {
  const text = '<ApplyPatch><patch><![CDATA[*** Begin Patch\n*** End Patch]]></patch></ApplyPatch>';
  const result = parseXmlToolCallsDetailed(text, { triggerSignal: '<Function_AB12_Start/>', tools });
  assert.equal(result.toolCalls, null);
  assert.equal(result.failureType, 'schema_error');
  assert.match(result.errorDetails, /no ApplyPatch\/apply_patch tool is available/);
});

test('ApplyPatch XML inside think blocks is ignored', () => {
  const text = '<think><ApplyPatch><patch><![CDATA[*** Begin Patch]]></patch></ApplyPatch></think>普通回复';
  const result = parseXmlToolCallsDetailed(text, { triggerSignal: '<Function_AB12_Start/>', tools: bareTools });
  assert.equal(result.failureType, 'no_fc');
  assert.equal(result.toolCalls, null);
});

test('XML instructions explicitly reject ApplyPatch pseudo XML', () => {
  const instructions = buildXmlToolInstructions({ tools: bareTools, toolChoice: 'auto', triggerSignal: '<Function_AB12_Start/>' });
  assert.match(instructions, /<ApplyPatch>\.\.\.<\/ApplyPatch>/);
});

test('XML stream detector intercepts ApplyPatch pseudo XML and preserves prefix content', () => {
  const plan = createPromptPlan({ req: rawReq({ messages: [] }), tools: bareTools });
  const detector = plan.createStreamDetector();
  const prefix = '以下是修改后的完整文档。\n\n---\n\n';
  assert.equal(detector.process(prefix).delta, prefix);
  assert.equal(detector.process('<Apply').delta, '');
  const result = detector.process('Patch><patch><![CDATA[*** Begin Patch\n*** End Patch]]></patch></ApplyPatch>');
  assert.equal(result.completed, true);
  assert.equal(result.content, null);
  assert.equal(result.delta, '');
  assert.equal(result.toolCalls.length, 1);
  assert.equal(result.toolCalls[0].function.name, 'ApplyPatch');
  assert.match(JSON.parse(result.toolCalls[0].function.arguments).patch, /\*\*\* Begin Patch/);
  assert.equal(detector.finish().delta, '');
});

test('XML stream detector intercepts bracket pseudo calls before they leak', () => {
  const plan = createPromptPlan({ req: rawReq({ messages: [] }), tools: bareTools });
  const detector = plan.createStreamDetector();
  const prefix = '我来分析项目。\n';
  assert.equal(detector.process(prefix).delta, prefix);
  assert.equal(detector.process('[调').delta, '');
  assert.equal(detector.process('用 Glob] ').delta, '');
  const result = detector.process('{"pattern":"*","path":"D:\\\\tools\\\\test"}');
  assert.equal(result.completed, true);
  assert.equal(result.delta, '');
  assert.equal(result.content, null);
  assert.equal(result.toolCalls.length, 1);
  assert.equal(result.toolCalls[0].function.name, 'Glob');
  assert.deepEqual(JSON.parse(result.toolCalls[0].function.arguments), { pattern: '*', path: 'D:\\tools\\test' });
  assert.equal(detector.finish().delta, '');
});

test('parseArgsJson trims extra closing braces from args_json with }} at end', () => {
  const trigger = '<Function_AB12_Start/>';
  // This is the actual user scenario: model emitted }} at end of CDATA
  const parsed = parseXmlToolCallsFromText(
    `${trigger}\n<function_calls>\n<function_call><tool>Read</tool><args_json><![CDATA[{"file_path":"C:\\\\repo\\\\README.md"}}]]></args_json>\n</function_call>\n</function_calls>`,
    { triggerSignal: trigger, tools },
  );
  assert.equal(parsed.toolCalls.length, 1);
  assert.equal(JSON.parse(parsed.toolCalls[0].function.arguments).file_path, 'C:\\repo\\README.md');
});

test('parse function_calls batch strips extra non-schema args so the batch succeeds', () => {
  const trigger = '<Function_AB12_Start/>';
  // Real scenario: batch with valid Glob calls and Bash calls carrying extra "description" field
  const batchTools = [
    ...bareTools,
    {
      type: 'function',
      function: {
        name: 'Bash',
        description: 'Run a shell command',
        parameters: {
          type: 'object',
          properties: {
            command: { type: 'string' },
          },
          required: ['command'],
        },
      },
    },
  ];
  const text = `<Function_AB12_Start/>
<function_calls>
<function_call>
<tool>Bash</tool>
<args_json><![CDATA[{"command":"ls -la","description":"List project root"}]]></args_json>
</function_call>
<function_call>
<tool>Glob</tool>
<args_json><![CDATA[{"pattern":"*.json","path":"D:\\\\tools\\\\ting13"}]]></args_json>
</function_call>
</function_calls>`;
  const result = parseXmlToolCallsDetailed(text, { triggerSignal: trigger, tools: batchTools });
  assert.equal(result.failureType, null);
  assert.equal(result.toolCalls.length, 2);
  assert.equal(result.toolCalls[0].function.name, 'Bash');
  assert.equal(JSON.parse(result.toolCalls[0].function.arguments).command, 'ls -la');
  // description must be stripped, not present in the final arguments
  assert.ok(!Object.prototype.hasOwnProperty.call(JSON.parse(result.toolCalls[0].function.arguments), 'description'));
  assert.equal(result.toolCalls[1].function.name, 'Glob');
  assert.deepEqual(JSON.parse(result.toolCalls[1].function.arguments), { pattern: '*.json', path: 'D:\\tools\\ting13' });
});

test('repairs malformed CDATA close marker ]> so shell_command batch still parses', () => {
  const trigger = '<Function_ZE7n_Start/>';
  const shellTools = [{
    type: 'function',
    function: {
      name: 'shell_command',
      description: 'Run a shell command',
      parameters: {
        type: 'object',
        properties: { command: { type: 'string' }, justification: { type: 'string' } },
        required: ['command'],
      },
    },
  }];
  // Upstream wrote `]>` instead of `]]>` at every CDATA close (missing one `]`).
  const text = `已经看到项目根目录，接下来我会阅读核心文档来了解项目目标、开发流程和技术栈。

${trigger}
<function_calls>
  <function_call>
    <tool>shell_command</tool>
    <args_json><![CDATA[{"command":"Get-Content -Path D:\\\\tools\\\\ting13\\\\README.md","justification":"Reading README.md for project overview"}]></args_json>
  </function_call>
  <function_call>
    <tool>shell_command</tool>
    <args_json><![CDATA[{"command":"Get-Content -Path D:\\\\tools\\\\ting13\\\\.trellis\\\\workflow.md","justification":"Reading workflow.md for development phases"}]></args_json>
  </function_call>
</function_calls>`;
  const result = parseXmlToolCallsDetailed(text, { triggerSignal: trigger, tools: shellTools });
  assert.equal(result.failureType, null);
  assert.equal(result.toolCalls.length, 2);
  assert.equal(result.toolCalls[0].function.name, 'shell_command');
  assert.match(JSON.parse(result.toolCalls[0].function.arguments).command, /README\.md/);
  assert.match(JSON.parse(result.toolCalls[1].function.arguments).command, /workflow\.md/);
  assert.equal(result.content, '已经看到项目根目录，接下来我会阅读核心文档来了解项目目标、开发流程和技术栈。');
});

test('malformed CDATA repair leaves a legitimate ]> inside args value untouched', () => {
  const trigger = '<Function_AB12_Start/>';
  const grepTools = [{
    type: 'function',
    function: {
      name: 'Grep',
      parameters: { type: 'object', properties: { pattern: { type: 'string' } }, required: ['pattern'] },
    },
  }];
  const text = `${trigger}\n<function_calls><function_call><tool>Grep</tool><args_json><![CDATA[{"pattern":"a]>b"}]]></args_json></function_call></function_calls>`;
  const result = parseXmlToolCallsDetailed(text, { triggerSignal: trigger, tools: grepTools });
  assert.equal(result.failureType, null);
  assert.equal(JSON.parse(result.toolCalls[0].function.arguments).pattern, 'a]>b');
});

test('repairs args_json missing closing brace (trailing Windows path backslash)', () => {
  const trigger = '<Function_7txq_Start/>';
  const shellTools = [{
    type: 'function',
    function: {
      name: 'shell_command',
      parameters: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] },
    },
  }];
  // 模型漏写结尾 }，且命令以 Windows 路径反斜杠结尾（CDATA 内写成 \\）
  const text = `我来查看一下当前的 UI 页面结构。\n\n${trigger}\n<function_calls>\n  <function_call>\n    <tool>shell_command</tool>\n    <args_json><![CDATA[{"command":"Get-ChildItem -Recurse -Depth 1 android-app\\\\app\\\\src\\\\main\\\\kotlin\\\\com\\\\tingapp\\\\tingshufm\\\\ui\\\\"]]></args_json>\n  </function_call>\n</function_calls>`;
  const result = parseXmlToolCallsDetailed(text, { triggerSignal: trigger, tools: shellTools });
  assert.equal(result.failureType, null);
  assert.equal(result.toolCalls.length, 1);
  assert.equal(result.toolCalls[0].function.name, 'shell_command');
  const command = JSON.parse(result.toolCalls[0].function.arguments).command;
  assert.match(command, /Get-ChildItem -Recurse -Depth 1/);
  assert.ok(command.endsWith('ui\\'), 'trailing backslash path must be preserved');
});

test('coerces schema oversize arrays (maxItems) so AskUserQuestion still executes', () => {
  const trigger = '<Function_1MrQ_Start/>';
  const askTools = [{
    type: 'function',
    function: {
      name: 'AskUserQuestion',
      description: 'Ask the user a question',
      parameters: {
        type: 'object',
        properties: {
          questions: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                question: { type: 'string' },
                header: { type: 'string', maxLength: 12 },
                options: {
                  type: 'array',
                  minItems: 2,
                  maxItems: 4,
                  items: {
                    type: 'object',
                    properties: {
                      label: { type: 'string', maxLength: 30 },
                      description: { type: 'string' },
                    },
                    required: ['label', 'description'],
                    additionalProperties: false,
                  },
                },
                multiSelect: { type: 'boolean' },
              },
              required: ['question', 'header', 'options', 'multiSelect'],
              additionalProperties: false,
            },
          },
        },
        required: ['questions'],
        additionalProperties: false,
      },
    },
  }];
  // 5 options on question 1 — Claude Code schema maxItems=4
  const text = `${trigger}
<function_calls>
  <function_call>
    <tool>AskUserQuestion</tool>
    <args_json><![CDATA[{
      "questions": [
        {
          "question": "是否允许为“优化设置页面样式”创建 Trellis 任务并进入规划阶段？",
          "header": "任务管理",
          "options": [
            { "label": "是，创建任务并规划", "description": "我会创建 Trellis 任务" },
            { "label": "否，直接修改代码", "description": "跳过任务创建" }
          ],
          "multiSelect": false
        },
        {
          "question": "您希望重点优化哪些方面？（可多选）",
          "header": "优化方向",
          "options": [
            { "label": "间距与对齐", "description": "调整布局" },
            { "label": "颜色与主题", "description": "优化颜色" },
            { "label": "字体与排版", "description": "调整字体" },
            { "label": "交互反馈", "description": "增强反馈" },
            { "label": "视觉细节", "description": "提升精致度" }
          ],
          "multiSelect": true
        }
      ]
    }]]></args_json>
  </function_call>
</function_calls>`;
  const result = parseXmlToolCallsDetailed(text, { triggerSignal: trigger, tools: askTools });
  assert.equal(result.failureType, null);
  assert.equal(result.toolCalls.length, 1);
  assert.equal(result.toolCalls[0].function.name, 'AskUserQuestion');
  const args = JSON.parse(result.toolCalls[0].function.arguments);
  assert.equal(args.questions.length, 2);
  assert.equal(args.questions[0].options.length, 2);
  // 第 5 个选项被截断，只保留前 4 个
  assert.equal(args.questions[1].options.length, 4);
  assert.deepEqual(args.questions[1].options.map(o => o.label), ['间距与对齐', '颜色与主题', '字体与排版', '交互反馈']);
  assert.match(args.questions[0].question, /是否允许为/);
});

test('repairs CJK-context ASCII double-quotes inside JSON string values', () => {
  const trigger = '<Function_acPD_Start/>';
  const askTools = [{
    type: 'function',
    function: {
      name: 'AskUserQuestion',
      description: 'Ask the user a question',
      parameters: {
        type: 'object',
        properties: {
          questions: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                question: { type: 'string' },
                header: { type: 'string' },
                options: { type: 'array', items: { type: 'object', properties: { label: { type: 'string' }, description: { type: 'string' } }, required: ['label', 'description'] } },
                multiSelect: { type: 'boolean' },
              },
              required: ['question', 'header', 'options', 'multiSelect'],
            },
          },
        },
        required: ['questions'],
      },
    },
  }];
  const text = `${trigger}\n<function_calls>\n  <function_call>\n    <tool>AskUserQuestion</tool>\n    <args_json><![CDATA[{"questions":[{"question":"是否允许为"优化设置页面样式"创建","header":"任务","options":[{"label":"是","description":"创建"}],"multiSelect":false}]}]]></args_json>\n  </function_call>\n</function_calls>`;
  const result = parseXmlToolCallsDetailed(text, { triggerSignal: trigger, tools: askTools });
  assert.equal(result.failureType, null);
  assert.equal(result.toolCalls.length, 1);
  assert.equal(result.toolCalls[0].function.name, 'AskUserQuestion');
  const args = JSON.parse(result.toolCalls[0].function.arguments);
  assert.equal(args.questions.length, 1);
  assert.match(args.questions[0].question, /是否允许为/);
});

test('normalizes shell/terminal/execute aliases to Bash and repairs command array', () => {
  const trigger = '<Function_AB12_Start/>';
  const text = `我来帮你分析这个项目。先看看项目结构和关键文件。\n\n${trigger}\n<function_calls>\n  <function_call>\n    <tool>shell</tool>\n    <args_json><![CDATA[{"command": ["powershell.exe", "-Command", "Get-ChildItem -Path D:\\\\tools\\\\ting13 -Force"]}]]></args_json>\n  </function_call>\n</function_calls>`;
  const toolsWithBash = [
    ...bareTools,
    {
      type: 'function',
      function: {
        name: 'Bash',
        description: 'Run a shell command',
        parameters: {
          type: 'object',
          properties: { command: { type: 'string' } },
          required: ['command'],
        },
      },
    },
  ];
  const result = parseXmlToolCallsDetailed(text, { triggerSignal: trigger, tools: toolsWithBash });
  assert.equal(result.failureType, null);
  assert.equal(result.toolCalls.length, 1);
  assert.equal(result.toolCalls[0].function.name, 'Bash');
  const args = JSON.parse(result.toolCalls[0].function.arguments);
  // command array must be repaired to a single string
  assert.equal(typeof args.command, 'string');
  assert.match(args.command, /powershell\.exe/);
  assert.match(args.command, /Get-ChildItem/);
});

test('resolves known tool names case-insensitively via resolveToolName', () => {
  const trigger = '<Function_AB12_Start/>';
  // Model outputs "read" (lowercase), tool is "Read" — must match
  const text = `${trigger}\n<function_calls>\n<function_call>\n<tool>read</tool>\n<args_json><![CDATA[{"file_path":"C:\\\\repo\\\\README.md"}]]></args_json>\n</function_call>\n</function_calls>`;
  const parsed = parseXmlToolCallsFromText(text, { triggerSignal: trigger, tools });
  assert.ok(parsed, 'should parse lowercase tool name');
  assert.equal(parsed.toolCalls.length, 1);
  assert.equal(parsed.toolCalls[0].function.name, 'Read');
  assert.equal(JSON.parse(parsed.toolCalls[0].function.arguments).file_path, 'C:\\repo\\README.md');
});

test('resolves shell_command alias to Bash with valid command', () => {
  const trigger = '<Function_ZqfA_Start/>';
  const text = `${trigger}\n<function_calls>\n  <function_call>\n    <tool>shell_command</tool>\n    <args_json><![CDATA[{"command":"Get-ChildItem -Force | Select-Object Name, Mode, Length"}]]></args_json>\n  </function_call>\n</function_calls>`;
  const toolsWithBash = [
    ...bareTools,
    { type: 'function', function: { name: 'Bash', description: 'Run shell', parameters: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] } } },
  ];
  const result = parseXmlToolCallsDetailed(text, { triggerSignal: trigger, tools: toolsWithBash });
  assert.equal(result.failureType, null);
  assert.equal(result.toolCalls.length, 1);
  assert.equal(result.toolCalls[0].function.name, 'Bash');
  assert.equal(JSON.parse(result.toolCalls[0].function.arguments).command, 'Get-ChildItem -Force | Select-Object Name, Mode, Length');
});

test('keeps shell_command when the client exposes shell_command as the actual tool', () => {
  const trigger = '<Function_ZqfA_Start/>';
  const text = `好的，我来分析这个项目。先看看目录结构和关键文件。\n\n<function_calls>\n  <function_call>\n    <tool>shell_command</tool>\n    <args_json><![CDATA[{"command":"Get-ChildItem -Force -Name","workdir":"D:\\tools\\ting13"}]]></args_json>\n  </function_call>\n</function_calls>`;
  const codexTools = [{
    type: 'function',
    function: {
      name: 'shell_command',
      description: 'Run a shell command',
      parameters: {
        type: 'object',
        properties: {
          command: { type: 'string' },
          workdir: { type: 'string' },
        },
        required: ['command'],
      },
    },
  }];
  const result = parseXmlToolCallsDetailed(text, { triggerSignal: trigger, tools: codexTools });
  assert.equal(result.failureType, null);
  assert.equal(result.content, '好的，我来分析这个项目。先看看目录结构和关键文件。');
  assert.equal(result.toolCalls.length, 1);
  assert.equal(result.toolCalls[0].function.name, 'shell_command');
  assert.deepEqual(JSON.parse(result.toolCalls[0].function.arguments), {
    command: 'Get-ChildItem -Force -Name',
    workdir: 'D:\\tools\\ting13',
  });
});

test('parses Windows paths with backslash-t in command arg via force-literal fallback', () => {
  const trigger = '<Function_AB12_Start/>';
  // Construct the CDATA body with literal backslash before "tools" (\\t, not a tab)
  const body = '{"command":"Get-ChildItem -Force -Path \\"D:\\tools\\ting13\\""}';
  const text = trigger + '\n<function_calls>\n  <function_call>\n    <tool>shell_command</tool>\n    <args_json><![CDATA[' + body + ']]></args_json>\n  </function_call>\n</function_calls>';
  const toolsWithBash = [
    ...bareTools,
    { type: 'function', function: { name: 'Bash', description: 'Run shell', parameters: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] } } },
  ];
  const result = parseXmlToolCallsDetailed(text, { triggerSignal: trigger, tools: toolsWithBash });
  assert.equal(result.failureType, null);
  assert.equal(result.toolCalls.length, 1);
  assert.equal(result.toolCalls[0].function.name, 'Bash');
  const cmd = JSON.parse(result.toolCalls[0].function.arguments).command;
  assert.ok(cmd.includes('Get-ChildItem'), 'should contain Get-ChildItem');
  assert.ok(cmd.includes('ting13'), 'should contain ting13');
  assert.ok(cmd.includes('D:\\tools'), 'should contain D:\\tools');
});
