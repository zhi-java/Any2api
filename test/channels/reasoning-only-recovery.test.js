import test from 'node:test';
import assert from 'node:assert/strict';

import { collectInternalEvents } from '../../src/core/internal-events.js';
import { createInternalRequest } from '../../src/core/internal-request.js';
import { runParsedStreamChannel } from '../../src/channels/common-internal-runner.js';
import { getReasoningOnlyRetryPrompt, isEmptyAssistantReply } from '../../src/core/tool-retry.js';

// ---------------------------------------------------------------------------
// 背景（真实场景，2026-09-14 线上日志）：
//   deepseek-flash 在多轮工具调用后，上游有时只输出 thinking 而完全不输出
//   正文（finishReason=stop）。客户端因此只看到思考、看不到答案，任务中断。
//   该行为发生在上游，无法通过解析修复，只能在代理层检测并续写恢复。
// ---------------------------------------------------------------------------

function request(messages = [{ role: 'user', content: '我的任务' }], tools = []) {
  return createInternalRequest({
    protocol: 'chat',
    model: 'test-model',
    messages,
    tools,
  });
}

test('isEmptyAssistantReply detects reasoning-only replies', () => {
  // 只思考、无正文 → 需要恢复
  assert.equal(isEmptyAssistantReply({ visibleContent: '', reasoningContent: '想清楚了' }), true);
  // 有正文 → 不需要
  assert.equal(isEmptyAssistantReply({ visibleContent: '答案', reasoningContent: '想清楚了' }), false);
  // 两者都空 → 不触发（可能是正常空回复或工具调用轮）
  assert.equal(isEmptyAssistantReply({ visibleContent: '', reasoningContent: '' }), false);
  // 只有空白字符的正文视为空
  assert.equal(isEmptyAssistantReply({ visibleContent: '   \n ', reasoningContent: '想' }), true);
});

test('reasoning-only recovery prompt asks for the final answer, not more thinking', () => {
  const prompt = getReasoningOnlyRetryPrompt('用户问：有哪些任务？', '已列出 6 个任务，按优先级排序…');
  // 必须明确禁止再思考、要求直接给正文
  assert.match(prompt, /不要再输出思考|不要继续思考|直接输出/);
  assert.match(prompt, /正文|最终回答|答案/);
  // 应带上用户的原始请求与已完成的思考结论，供模型续写
  assert.match(prompt, /有哪些任务/);
  assert.match(prompt, /按优先级排序/);
});

test('runner recovers when upstream returns reasoning only, then no visible text', async () => {
  const req = request();
  let retryCalled = 0;
  let capturedPrompt = '';

  const events = await collectInternalEvents(runParsedStreamChannel(req, {}, {
    channelName: 'Test',
    responseModel: 'test-model',
    async startStream({ messages }) {
      return {
        streamBody: {},
        async retryToolRequest() { return ''; },
        // 恢复回调：返回续写得到的正文
        async retryReasoningOnly({ retryPrompt }) {
          retryCalled += 1;
          capturedPrompt = retryPrompt;
          return '1. 任务A（P0）\n2. 任务B（P1）';
        },
      };
    },
    async *parseStream() {
      // 上游只发思考，没有 content
      yield { type: 'thinking', content: '用户要 5 个板块，GDT-194 逾期排最前…' };
      yield { type: 'done' };
    },
  }));

  assert.equal(retryCalled, 1, '仅在无正文时应触发一次续写');
  assert.match(capturedPrompt, /不要再输出思考|直接输出/);

  const text = events.filter(e => e.type === 'content.text.delta').map(e => e.delta).join('');
  assert.equal(text, '1. 任务A（P0）\n2. 任务B（P1）', '续写内容应作为正文流出');
  assert.equal(events.find(e => e.type === 'run.completed').finishReason, 'stop');
  // 思考内容仍应完整保留
  assert.ok(events.some(e => e.type === 'reasoning.done'));
});

test('runner does not attempt recovery when visible text exists', async () => {
  const req = request();
  let retryCalled = 0;

  const events = await collectInternalEvents(runParsedStreamChannel(req, {}, {
    channelName: 'Test',
    responseModel: 'test-model',
    async startStream() {
      return {
        streamBody: {},
        async retryToolRequest() { return ''; },
        async retryReasoningOnly() { retryCalled += 1; return '不应被调用'; },
      };
    },
    async *parseStream() {
      yield { type: 'thinking', content: '先想一想' };
      yield { type: 'content', content: '这是正文答案' };
      yield { type: 'done' };
    },
  }));

  assert.equal(retryCalled, 0, '有正文时不得触发续写');
  const text = events.filter(e => e.type === 'content.text.delta').map(e => e.delta).join('');
  assert.equal(text, '这是正文答案');
});

test('runner does not attempt recovery when upstream returned tool calls', async () => {
  const req = request(
    [{ role: 'user', content: '读取文件' }],
    [{ name: 'Read', parameters: { type: 'object', properties: { file_path: { type: 'string' } }, required: ['file_path'] } }],
  );
  let retryCalled = 0;

  const events = await collectInternalEvents(runParsedStreamChannel(req, {}, {
    channelName: 'Test',
    responseModel: 'test-model',
    async startStream() {
      return {
        streamBody: {},
        async retryToolRequest() { return ''; },
        async retryReasoningOnly() { retryCalled += 1; return '不应被调用'; },
      };
    },
    async *parseStream() {
      yield { type: 'thinking', content: '需要读文件' };
      yield {
        type: 'tool_calls',
        toolCalls: [{ id: 'c1', type: 'function', function: { name: 'Read', arguments: { file_path: '/a' } } }],
      };
    },
  }));

  assert.equal(retryCalled, 0, '工具调用轮不得触发正文续写');
  assert.equal(events.find(e => e.type === 'run.completed').finishReason, 'tool_calls');
});

test('runner stays silent when recovery also yields nothing', async () => {
  const req = request();

  const events = await collectInternalEvents(runParsedStreamChannel(req, {}, {
    channelName: 'Test',
    responseModel: 'test-model',
    async startStream() {
      return {
        streamBody: {},
        async retryToolRequest() { return ''; },
        async retryReasoningOnly() { return ''; },
      };
    },
    async *parseStream() {
      yield { type: 'thinking', content: '只是想了想' };
      yield { type: 'done' };
    },
  }));

  // 恢复失败也不应崩溃，不得伪造正文
  const text = events.filter(e => e.type === 'content.text.delta').map(e => e.delta).join('');
  assert.equal(text, '');
  assert.equal(events.find(e => e.type === 'run.completed').finishReason, 'stop');
});
