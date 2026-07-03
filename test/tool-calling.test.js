import test from 'node:test';
import assert from 'node:assert/strict';

import { convertClaudeRequest } from '../src/adapters/claude.js';
import { convertMessages as convertGLMMessages } from '../src/channels/glm/client.js';
import { buildQwenMessages } from '../src/channels/qwen/client.js';
import { buildClaudeResponseFromContent } from '../src/utils/claude-response.js';
import { buildOpenAIResponseFromContent, writeStreamingToolCalls } from '../src/utils/openai-response.js';
import {
  buildPersistentToolDefs,
  buildToolInstructions,
  buildToolRetryPrompt,
  createJsonContentExtractor,
  extractAssistantResponse,
  looksLikeMalformedToolOutput,
  parseToolCallsFromText,
  textFromContent,
  validateToolCallsPipeline,
} from '../src/utils/response-utils.js';

const weatherTool = {
  type: 'function',
  function: {
    name: 'get_weather',
    description: 'Get weather by city',
    parameters: {
      type: 'object',
      properties: { city: { type: 'string' } },
      required: ['city'],
    },
  },
};

const readTool = {
  type: 'function',
  function: {
    name: 'Read',
    description: 'Reads a file from the local filesystem.',
    parameters: {
      type: 'object',
      properties: {
        file_path: { type: 'string', description: 'The absolute path to the file to read. Must be absolute.' },
        limit: { type: 'integer', description: 'Optional line limit.' },
      },
      required: ['file_path'],
    },
  },
};

const dbSchemaTool = {
  type: 'function',
  function: {
    name: 'mcp__Db__getSchema',
    description: 'Get database schema metadata.',
    parameters: { type: 'object', properties: {} },
  },
};

test('textFromContent removes redundant JSON string escaping from API message text', () => {
  assert.equal(textFromContent('"hello\\nworld"'), 'hello\nworld');
  assert.equal(textFromContent(String.raw`{\"query\":\"天气\"}`), '{"query":"天气"}');
  assert.equal(
    textFromContent([{ type: 'text', text: String.raw`{\"path\":\"C:\\\\Users\\\\Administrator\\\\README.md\"}` }]),
    '{"path":"C:\\\\Users\\\\Administrator\\\\README.md"}',
  );
  assert.equal(textFromContent({ type: 'text', text: 'plain object text' }), 'plain object text');
  assert.equal(textFromContent(String.raw`C:\Users\Administrator\README.md`), String.raw`C:\Users\Administrator\README.md`);
});

test('buildToolInstructions uses JSON template format with Chinese instructions', () => {
  const prompt = buildToolInstructions([weatherTool], 'auto');

  // 验证使用新的 JSON 模板格式
  assert.match(prompt, /可用工具列表/);
  assert.match(prompt, /原始 JSON/);
  assert.match(prompt, /assistant_response/);
  assert.match(prompt, /tool_calls/);
  assert.match(prompt, /Markdown 围栏/);
  assert.match(prompt, /禁止编造/);
  assert.match(prompt, /大结果工具调用规则/);
  assert.match(prompt, /优先选择支持分页、过滤、字段选择/);
  assert.match(prompt, /limit、offset、page、pageSize、cursor/);
  assert.match(prompt, /不要一次性请求全量数据库 schema/);
  assert.match(prompt, /工具结果包含 nextCursor、hasMore、total/);
  // 验证不再包含旧 XML 格式
  assert.doesNotMatch(prompt, /<tool_calls>/);
  assert.doesNotMatch(prompt, /XML/);
});

test('buildToolInstructions with required tool_choice adds Chinese instruction', () => {
  const prompt = buildToolInstructions([weatherTool], 'required');

  assert.match(prompt, /你必须调用至少一个工具/);
});

test('buildToolInstructions with forced tool_choice adds specific Chinese instruction', () => {
  const prompt = buildToolInstructions([weatherTool], { type: 'function', function: { name: 'get_weather' } });

  assert.match(prompt, /你必须调用工具 `get_weather`/);
});

test('buildToolInstructions with none tool_choice returns empty prompt', () => {
  const prompt = buildToolInstructions([weatherTool], 'none');

  assert.equal(prompt, '');
});

test('buildToolInstructions without tools returns empty prompt', () => {
  const prompt = buildToolInstructions([], 'auto');

  assert.equal(prompt, '');
});

test('buildToolInstructions with custom prefix', () => {
  const prompt = buildToolInstructions([weatherTool], 'auto', '你是一个天气查询助手。');

  assert.match(prompt, /你是一个天气查询助手/);
});

test('convertGLMMessages does not inject tool JSON protocol when tool_choice is none', () => {
  const messages = convertGLMMessages(
    [{ role: 'user', content: '生成一个标题' }],
    [weatherTool],
    'none',
  );

  const prompt = messages[0].content[0].text;
  assert.doesNotMatch(prompt, /可用工具列表/);
  assert.doesNotMatch(prompt, /assistant_response/);
  assert.doesNotMatch(prompt, /tool_calls/);
});

test('buildQwenMessages does not inject tool JSON protocol when tool_choice is none', () => {
  const messages = buildQwenMessages(
    [{ role: 'user', content: '生成一个标题' }],
    [weatherTool],
    'none',
  );

  const prompt = messages[0].content;
  assert.doesNotMatch(prompt, /可用工具列表/);
  assert.doesNotMatch(prompt, /assistant_response/);
  assert.doesNotMatch(prompt, /tool_calls/);
});

test('buildQwenMessages injects tool JSON protocol when tools are enabled', () => {
  const messages = buildQwenMessages(
    [{ role: 'user', content: '查天气' }],
    [weatherTool],
    'auto',
  );

  const prompt = messages[0].content;
  assert.match(prompt, /可用工具列表/);
  assert.match(prompt, /assistant_response/);
  assert.match(prompt, /tool_calls/);
});

test('buildToolInstructions adds vibe coding guidance for coding tools', () => {
  const prompt = buildToolInstructions([readTool], 'auto');

  assert.match(prompt, /Vibe coding 工具使用规则/);
  assert.match(prompt, /Claude Code \/ Codex/);
  assert.match(prompt, /查看文件优先使用 Read/);
  assert.match(prompt, /Read 大文件必须分段读取/);
  assert.match(prompt, /limit 控制单次读取量/);
  assert.match(prompt, /offset 接续/);
  assert.match(prompt, /完整绝对路径/);
  assert.match(prompt, /已有内容/);
  assert.match(prompt, /禁止直接用 Write 覆盖已有内容/);
  assert.match(prompt, /工具调用完成后必须反馈/);
  assert.match(prompt, /禁止以空内容结束多轮任务/);
});

test('buildPersistentToolDefs uses JSON format instead of XML', () => {
  const prompt = buildPersistentToolDefs(
    [{ role: 'assistant', tool_calls: [{ id: 'call_1', function: { name: 'get_weather', arguments: '{}' } }] }],
    [],
    [weatherTool],
  );

  assert.match(prompt, /持久化工具定义/);
  assert.match(prompt, /assistant_response/);
  assert.match(prompt, /tool_calls/);
  assert.doesNotMatch(prompt, /XML/);
  assert.doesNotMatch(prompt, /<tool_calls>/);
});

test('parseToolCallsFromText recovers JSON format tool calls', () => {
  const parsed = parseToolCallsFromText(
    '{"assistant_response": null, "tool_calls": [{"name":"get_weather","arguments":{"city":"Beijing"}}]}',
  );

  assert.equal(parsed.toolCalls.length, 1);
  assert.equal(parsed.toolCalls[0].function.name, 'get_weather');
  assert.equal(parsed.toolCalls[0].function.arguments, '{"city":"Beijing"}');
  assert.equal(parsed.content, null);
});

test('parseToolCallsFromText recovers JSON format with assistant response', () => {
  const parsed = parseToolCallsFromText(
    '{"assistant_response": "让我查一下天气", "tool_calls": [{"name":"get_weather","arguments":{"city":"Beijing"}}]}',
  );

  assert.equal(parsed.toolCalls.length, 1);
  assert.equal(parsed.toolCalls[0].function.name, 'get_weather');
  assert.equal(parsed.content, '让我查一下天气');
});

test('parseToolCallsFromText recovers descriptive text followed by bare json command block', () => {
  const parsed = parseToolCallsFromText(String.raw`我来对 README.md 进行系统优化，逐部分改进表述、结构和专业性。

首先，优化描述和徽章区域：

json
{
  "assistant_response": null,
  "tool_calls": [
    {
      "name": "Edit",
      "arguments": {
        "file_path": "C:\\Users\\Administrator\\IdeaProjects\\Any2api\\README.md",
        "old_string": "# Any2API — 多模型协议桥\n\n> 将各大模型 Web 聊天接口封装为 OpenAI / Anthropic 标准 API，统一工具调用，智能 Token 管理。",
        "new_string": "# Any2API — 多模型协议桥\n\n> 将各大模型 Web 聊天接口封装为 OpenAI / Anthropic 标准 API，提供统一工具调用、智能 Token 管理与高可用网关能力。"
      }
    }
  ]
}`);

  assert.equal(parsed.toolCalls.length, 1);
  assert.equal(parsed.toolCalls[0].function.name, 'Edit');
  assert.deepEqual(JSON.parse(parsed.toolCalls[0].function.arguments), {
    file_path: 'C:\\Users\\Administrator\\IdeaProjects\\Any2api\\README.md',
    old_string: '# Any2API — 多模型协议桥\n\n> 将各大模型 Web 聊天接口封装为 OpenAI / Anthropic 标准 API，统一工具调用，智能 Token 管理。',
    new_string: '# Any2API — 多模型协议桥\n\n> 将各大模型 Web 聊天接口封装为 OpenAI / Anthropic 标准 API，提供统一工具调用、智能 Token 管理与高可用网关能力。',
  });
  assert.equal(parsed.content, '我来对 README.md 进行系统优化，逐部分改进表述、结构和专业性。\n\n首先，优化描述和徽章区域：');
});

test('parseToolCallsFromText recovers JSON format without tool calls (plain text)', () => {
  const parsed = parseToolCallsFromText(
    '{"assistant_response": "你好！今天天气不错。", "tool_calls": []}',
  );

  assert.equal(parsed.toolCalls, null);
  assert.equal(parsed.content, '你好！今天天气不错。');
});

test('parseToolCallsFromText cleans relaxed Qwen JSON wrapper without tool calls', () => {
  const parsed = parseToolCallsFromText(`{
  "assistant_response": "第一段

### 小节
- 内容",
  "tool_calls": []
}`);

  assert.equal(parsed.toolCalls, null);
  assert.equal(parsed.content, '第一段\n\n### 小节\n- 内容');
});

test('writeStreamingToolCalls streams only assistant_response for relaxed empty wrapper', () => {
  const res = {
    writableEnded: false,
    destroyed: false,
    chunks: [],
    write(chunk) {
      this.chunks.push(chunk);
      return true;
    },
  };

  const wrote = writeStreamingToolCalls(res, 'chatcmpl_test', 'qwen3.7-plus', `{
  "assistant_response": "《凡人修仙传》介绍",
  "tool_calls": []
}`, true, [], 'none');

  const output = res.chunks.join('');
  assert.equal(wrote, true);
  assert.match(output, /《凡人修仙传》介绍/);
  assert.doesNotMatch(output, /assistant_response/);
  assert.doesNotMatch(output, /tool_calls/);
});

test('parseToolCallsFromText still recovers legacy XML tool calls', () => {
  const parsed = parseToolCallsFromText(
    'Let me check. <tool_calls>[{"name":"get_weather","arguments":{"city":"Beijing"}}]</tool_calls>',
  );

  assert.equal(parsed.toolCalls.length, 1);
  assert.equal(parsed.toolCalls[0].function.name, 'get_weather');
  assert.equal(parsed.toolCalls[0].function.arguments, '{"city":"Beijing"}');
  assert.equal(parsed.content, 'Let me check.');
});

test('parseToolCallsFromText strips repeated bare opening tags from model loops', () => {
  const parsed = parseToolCallsFromText('我需要先读取文件。\n\n<tool_calls>\n<tool_calls>\n<tool_calls>');

  assert.equal(parsed.toolCalls, null);
  assert.equal(parsed.content, '我需要先读取文件。');
});

test('parseToolCallsFromText recovers nested tool_call tag with name attribute', () => {
  const parsed = parseToolCallsFromText(
    '让我先读取当前的 README.md 文件内容。\n\n<tool_calls>\n<tool_calls>\n<tool_calls>\n<tool_call name="Read">{"file_path": "C:\\Users\\Administrator\\IdeaProjects\\Any2api\\README.md"}</tool_call>\n</tool_calls>\n</tool_calls>',
  );

  assert.equal(parsed.toolCalls.length, 1);
  assert.equal(parsed.toolCalls[0].function.name, 'Read');
  assert.deepEqual(JSON.parse(parsed.toolCalls[0].function.arguments), {
    file_path: 'C:\\Users\\Administrator\\IdeaProjects\\Any2api\\README.md',
  });
  assert.equal(parsed.content, '让我先读取当前的 README.md 文件内容。');
});

test('parseToolCallsFromText strips unrecoverable tool_call XML variants', () => {
  const parsed = parseToolCallsFromText('准备调用工具。\n<tool_call>{"file_path":"README.md"}</tool_call>');

  assert.equal(parsed.toolCalls, null);
  assert.equal(parsed.content, '准备调用工具。');
});

test('validateToolCallsPipeline filters hallucinated tools and keeps valid calls', () => {
  const parsed = parseToolCallsFromText(
    '{"assistant_response": null, "tool_calls": [{"name":"fake_tool","arguments":{}},{"name":"get_weather","arguments":{"city":"Beijing"}}]}',
  );
  const { toolCalls, warning } = validateToolCallsPipeline(parsed.toolCalls, 'auto', [weatherTool]);

  assert.equal(toolCalls.length, 1);
  assert.equal(toolCalls[0].function.name, 'get_weather');
  assert.match(warning, /Filtered 1 hallucinated tool/);
});

test('convertClaudeRequest preserves Anthropic forced tool_choice', () => {
  const converted = convertClaudeRequest({
    model: 'deepseek-v4-pro',
    max_tokens: 100,
    messages: [{ role: 'user', content: '天气？' }],
    tools: [{ name: 'get_weather', input_schema: weatherTool.function.parameters }],
    tool_choice: { type: 'tool', name: 'get_weather' },
  });

  assert.deepEqual(converted.tool_choice, {
    type: 'function',
    function: { name: 'get_weather' },
  });
});

test('convertClaudeRequest maps Anthropic any tool_choice to required', () => {
  const converted = convertClaudeRequest({
    model: 'deepseek-v4-pro',
    max_tokens: 100,
    messages: [{ role: 'user', content: '天气？' }],
    tools: [{ name: 'get_weather', input_schema: weatherTool.function.parameters }],
    tool_choice: { type: 'any' },
  });

  assert.equal(converted.tool_choice, 'required');
});

test('convertClaudeRequest converts Claude tool_result arrays to text tool messages', () => {
  const converted = convertClaudeRequest({
    model: 'deepseek-v4-pro',
    max_tokens: 100,
    messages: [
      { role: 'user', content: '读取文件' },
      { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_read_1', name: 'Read', input: { file_path: 'C:\\Users\\Administrator\\IdeaProjects\\Any2api\\README.md' } }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_read_1', content: [{ type: 'text', text: 'README 内容片段' }] }] },
    ],
  });

  assert.equal(converted.messages[2].role, 'tool');
  assert.equal(converted.messages[2].tool_call_id, 'toolu_read_1');
  assert.equal(converted.messages[2].content, 'README 内容片段');
});

test('convertClaudeRequest maps Anthropic adaptive thinking to upstream thinking flag', () => {
  const converted = convertClaudeRequest({
    model: 'deepseek-v4-pro',
    max_tokens: 100,
    messages: [{ role: 'user', content: '解释一下快速排序' }],
    thinking: { type: 'adaptive' },
  });

  assert.equal(converted.thinking_enabled, true);
});

test('convertClaudeRequest maps Anthropic disabled thinking to upstream thinking flag', () => {
  const converted = convertClaudeRequest({
    model: 'deepseek-v4-pro',
    max_tokens: 100,
    messages: [{ role: 'user', content: '直接回答（输出Markdown风格（详细版））' }],
    thinking: { type: 'disabled' },
  });

  assert.equal(converted.thinking_enabled, false);
});

test('buildClaudeResponseFromContent preserves thinking blocks before text', () => {
  const response = buildClaudeResponseFromContent({
    id: 'msg_test',
    model: 'deepseek-v4-pro',
    thinking: '先分析问题。',
    fullContent: '最终答案。',
  });

  assert.deepEqual(response.content, [
    { type: 'thinking', thinking: '先分析问题。', signature: '' },
    { type: 'text', text: '最终答案。' },
  ]);
});

test('buildOpenAIResponseFromContent cleans GLM JSON tool wrapper', () => {
  const response = buildOpenAIResponseFromContent({
    id: 'chatcmpl_test',
    model: 'glm-5.2',
    fullContent: '{"assistant_response": "要回答“数据库中有多少张表？”，我需要先查询数据库的元数据。让我为您获取表的数量。", "tool_calls": [{"name": "mcp__Db__getSchema", "arguments": {}}]}',
    toolCallingEnabled: true,
    definedTools: [dbSchemaTool],
  });

  const message = response.choices[0].message;
  assert.equal(message.content, '要回答“数据库中有多少张表？”，我需要先查询数据库的元数据。让我为您获取表的数量。');
  assert.equal(message.tool_calls.length, 1);
  assert.equal(message.tool_calls[0].function.name, 'mcp__Db__getSchema');
  assert.equal(response.choices[0].finish_reason, 'tool_calls');
});

test('buildClaudeResponseFromContent cleans GLM JSON tool wrapper', () => {
  const response = buildClaudeResponseFromContent({
    id: 'msg_test_glm',
    model: 'glm-5.2',
    fullContent: '{"assistant_response": "要回答“数据库中有多少张表？”，我需要先查询数据库的元数据。让我为您获取表的数量。", "tool_calls": [{"name": "mcp__Db__getSchema", "arguments": {}}]}',
    toolCallingEnabled: true,
    definedTools: [dbSchemaTool],
  });

  assert.deepEqual(response.content, [
    { type: 'text', text: '要回答“数据库中有多少张表？”，我需要先查询数据库的元数据。让我为您获取表的数量。' },
    { type: 'tool_use', id: response.content[1].id, name: 'mcp__Db__getSchema', input: {} },
  ]);
  assert.equal(response.stop_reason, 'tool_use');
});

test('extractAssistantResponse extracts text from JSON format', () => {
  const result = extractAssistantResponse(
    '{"assistant_response": "你好！今天天气不错。", "tool_calls": []}',
  );

  assert.equal(result.content, '你好！今天天气不错。');
  assert.equal(result.toolCalls, null);
});

test('extractAssistantResponse extracts tool_calls from JSON format', () => {
  const result = extractAssistantResponse(
    '{"assistant_response": null, "tool_calls": [{"name":"get_weather","arguments":{"city":"Beijing"}}]}',
  );

  assert.equal(result.content, null);
  assert.equal(result.toolCalls.length, 1);
  assert.equal(result.toolCalls[0].function.name, 'get_weather');
});

test('extractAssistantResponse returns raw text for non-JSON output', () => {
  const result = extractAssistantResponse('你好！今天天气不错。');

  assert.equal(result.content, '你好！今天天气不错。');
  assert.equal(result.toolCalls, null);
});

test('createJsonContentExtractor incrementally extracts assistant_response', () => {
  const extractor = createJsonContentExtractor();

  // 第一个 chunk：JSON 开头 + 完整 marker
  assert.equal(extractor.process('{"assistant_response": "'), '');
  // marker 已完整匹配，进入值区域
  assert.equal(extractor.isFound(), true);
  assert.equal(extractor.isDone(), false);

  // 第二个 chunk：进入值区域
  assert.equal(extractor.process('你好'), '你好');
  assert.equal(extractor.isDone(), false);

  // 第三个 chunk：值继续
  assert.equal(extractor.process('！今天'), '！今天');
  assert.equal(extractor.isDone(), false);

  // 第四个 chunk：值结束
  assert.equal(extractor.process('天气不错。"'), '天气不错。');
  assert.equal(extractor.isDone(), true);

  // 后续 chunk 不再输出
  assert.equal(extractor.process(', "tool_calls": []}'), '');
});

test('createJsonContentExtractor handles escaped quotes in value', () => {
  const extractor = createJsonContentExtractor();

  const first = extractor.process('{"assistant_response": "他说：\\"你好\\"');
  assert.equal(first, '他说："你好"');
  assert.equal(extractor.process('，世界。"'), '，世界。');
  assert.equal(extractor.isDone(), true);
});

test('createJsonContentExtractor handles \\n newline escape', () => {
  const extractor = createJsonContentExtractor();
  const result = extractor.process('{"assistant_response": "hello\\nworld"}');
  assert.equal(result, 'hello\nworld');
  assert.equal(extractor.isDone(), true);
});

test('createJsonContentExtractor handles newline escape split across chunks', () => {
  const extractor = createJsonContentExtractor();

  assert.equal(extractor.process('{"assistant_response": "hello\\'), 'hello');
  assert.equal(extractor.process('n\\nworld"}'), '\n\nworld');
  assert.equal(extractor.isDone(), true);
});

test('createJsonContentExtractor handles \\t tab escape', () => {
  const extractor = createJsonContentExtractor();
  const result = extractor.process('{"assistant_response": "a\\tb"}');
  assert.equal(result, 'a\tb');
  assert.equal(extractor.isDone(), true);
});

test('createJsonContentExtractor handles \\\\ double backslash', () => {
  const extractor = createJsonContentExtractor();
  const result = extractor.process('{"assistant_response": "路径：C:\\\\Users"}');
  assert.equal(result, '路径：C:\\Users');
  assert.equal(extractor.isDone(), true);
});

test('createJsonContentExtractor handles \\uXXXX unicode escape across chunks', () => {
  const extractor = createJsonContentExtractor();
  // 你 = 你, 好 = 好
  const first = extractor.process('{"assistant_response": "\\u4f60\\u597d"}');
  assert.equal(first, '你好');
  assert.equal(extractor.isDone(), true);
});

test('createJsonContentExtractor handles mixed escapes with Unicode across chunks', () => {
  const extractor = createJsonContentExtractor();
  const first = extractor.process('{"assistant_response": "Hello\\n\\u4f60\\u597d\\nWorld');
  assert.equal(first, 'Hello\n你好\nWorld');
  assert.equal(extractor.isDone(), false);
  assert.equal(extractor.process('!"'), '!');
  assert.equal(extractor.isDone(), true);
});

test('createJsonContentExtractor returns empty for non-JSON output', () => {
  const extractor = createJsonContentExtractor();

  assert.equal(extractor.process('你好'), '');
  assert.equal(extractor.isFound(), false);
  assert.equal(extractor.isDone(), false);
});

test('extractAssistantResponse handles Windows paths with single backslashes', () => {
  const result = extractAssistantResponse(
    '{"assistant_response": null, "tool_calls": [{"name":"Read","arguments":{"file_path":"C:\\Users\\Administrator\\README.md"}}]}',
  );

  assert.equal(result.content, null);
  assert.equal(result.toolCalls.length, 1);
  assert.equal(result.toolCalls[0].function.name, 'Read');
  assert.ok(result.toolCalls[0].function.arguments.includes('C:'));
});

test('extractAssistantResponse handles escaped Windows paths in arguments string', () => {
  const result = extractAssistantResponse(
    '{"assistant_response": null, "tool_calls": [{"name":"Read","arguments":"{\\"file_path\\":\\"C:\\\\Users\\\\Administrator\\\\README.md\\"}"}]}',
  );

  assert.equal(result.content, null);
  assert.equal(result.toolCalls.length, 1);
  assert.equal(result.toolCalls[0].function.name, 'Read');
});

test('looksLikeMalformedToolOutput detects Assistant tool calls echo', () => {
  assert.equal(looksLikeMalformedToolOutput('[Assistant tool calls]: [{"name":"Read"}]'), true);
  assert.equal(looksLikeMalformedToolOutput('[Tool result Read]: content'), true);
});

test('looksLikeMalformedToolOutput returns false for valid JSON format', () => {
  assert.equal(looksLikeMalformedToolOutput('{"assistant_response":"hello","tool_calls":[]}'), false);
  assert.equal(looksLikeMalformedToolOutput('普通文本回复'), false);
});

test('buildToolRetryPrompt includes previous response preview', () => {
  const prompt = buildToolRetryPrompt('[Assistant tool calls]: [{"name":"Read"}]');

  assert.match(prompt, /Assistant tool calls/);
  assert.match(prompt, /输出格式不正确/);
  assert.match(prompt, /assistant_response/);
  assert.match(prompt, /tool_calls/);
});

test('parseToolCallsFromText recovers [Assistant tool calls]: format', () => {
  const parsed = parseToolCallsFromText(
    '[Assistant tool calls]: [{"id":"call_1","type":"function","function":{"name":"get_weather","arguments":"{\\"city\\":\\"Beijing\\"}"}}]',
  );

  assert.equal(parsed.toolCalls.length, 1);
  assert.equal(parsed.toolCalls[0].function.name, 'get_weather');
});

test('parseToolCallsFromText recovers OpenAI tool_call format', () => {
  const parsed = parseToolCallsFromText(
    '{"assistant_response": null, "tool_calls": [{"id":"call_1","type":"function","function":{"name":"get_weather","arguments":{"city":"Beijing"}}}]}',
  );

  assert.equal(parsed.toolCalls.length, 1);
  assert.equal(parsed.toolCalls[0].function.name, 'get_weather');
});
