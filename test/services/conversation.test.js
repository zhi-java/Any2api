import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.ZHI2API_CONFIG_PATH = join(mkdtempSync(join(tmpdir(), 'omni-conversation-')), 'config.json');

const { loadConfig, updateConfig } = await import('../../src/services/config-store.js');
loadConfig({ force: true });
updateConfig({ runtime: { enableConversationAffinity: true } });

const {
  getConversationBinding,
  getConversationId,
  resolveConversation,
  recordResponseMessageId,
} = await import('../../src/services/conversation.js');

const TOKEN = 'token-abcdef123456';
const stubSession = (id) => async () => ({ id });

function reqWithHeaders(headers = {}) {
  return { headers };
}

test('auto binding matches previous turn via prefix hash and continues the session', async () => {
  const turn1 = [
    { role: 'system', content: 'sys-A' },
    { role: 'user', content: 'question-A' },
  ];
  const b1 = getConversationBinding(reqWithHeaders(), turn1);
  assert.ok(b1.conversationId);
  assert.equal(b1.matchedPrefixLength, 0);

  const r1 = await resolveConversation({ conversationId: b1.conversationId, modelType: 'default', token: TOKEN, createSessionFn: stubSession('sess-1') });
  assert.equal(r1.affinity, true);
  // 新会话上游没有历史，必须整体播种
  assert.equal(r1.promptMode, 'full');
  assert.equal(r1.sessionId, 'sess-1');
  recordResponseMessageId(b1.conversationId, 'msg-1');

  // 多轮客户端下一轮重发全量历史 + 新增消息（含并行工具结果）
  const turn2 = [
    ...turn1,
    { role: 'assistant', content: null, tool_calls: [{ id: 'c1', function: { name: 'Read', arguments: '{"file_path":"a"}' } }] },
    { role: 'tool', tool_call_id: 'c1', content: 'result-1' },
    { role: 'tool', tool_call_id: 'c2', content: 'result-2' },
  ];
  const b2 = getConversationBinding(reqWithHeaders(), turn2);
  assert.equal(b2.matchedPrefixLength, 2);
  assert.notEqual(b2.conversationId, b1.conversationId);

  const r2 = await resolveConversation({ conversationId: b2.conversationId, modelType: 'default', token: TOKEN, createSessionFn: stubSession('sess-unused') });
  assert.equal(r2.promptMode, 'latest');
  assert.equal(r2.sessionId, 'sess-1');
  assert.equal(r2.parentMessageId, 'msg-1');
});

test('identical resend matches its own full hash without creating a new session', async () => {
  const messages = [{ role: 'user', content: 'regenerate-case' }];
  const b1 = getConversationBinding(reqWithHeaders(), messages);
  await resolveConversation({ conversationId: b1.conversationId, modelType: 'default', token: TOKEN, createSessionFn: stubSession('regen-1') });

  const b2 = getConversationBinding(reqWithHeaders(), messages);
  assert.equal(b2.conversationId, b1.conversationId);
  assert.equal(b2.matchedPrefixLength, messages.length);

  const r2 = await resolveConversation({ conversationId: b2.conversationId, modelType: 'default', token: TOKEN, createSessionFn: stubSession('regen-2') });
  assert.equal(r2.sessionId, 'regen-1');
  assert.equal(r2.promptMode, 'latest');
});

test('session persists across many turns without turn-count rotation', async () => {
  const turn1 = [{ role: 'user', content: 'persist-case' }];
  const b1 = getConversationBinding(reqWithHeaders(), turn1);
  const r1 = await resolveConversation({ conversationId: b1.conversationId, modelType: 'default', token: TOKEN, createSessionFn: stubSession('persist-1') });
  assert.equal(r1.promptMode, 'full');
  recordResponseMessageId(b1.conversationId, 'persist-msg-1');

  // 连续多轮续接：不再有轮数上限，会话应一直复用而不轮换。
  let turn = turn1;
  for (let i = 2; i <= 12; i++) {
    turn = [...turn, { role: 'assistant', content: `answer-${i}` }, { role: 'user', content: `follow-up-${i}` }];
    const binding = getConversationBinding(reqWithHeaders(), turn);
    const resolved = await resolveConversation({ conversationId: binding.conversationId, modelType: 'default', token: TOKEN, createSessionFn: stubSession('persist-should-not-be-used') });
    assert.equal(resolved.sessionId, 'persist-1', `turn ${i} should keep the original session`);
    assert.equal(resolved.promptMode, 'latest');
    recordResponseMessageId(binding.conversationId, `persist-msg-${i}`);
  }
});

test('explicit conversation id header bypasses prefix matching', () => {
  const binding = getConversationBinding(reqWithHeaders({ 'x-conversation-id': 'cli-42' }), [{ role: 'user', content: 'x' }]);
  assert.equal(binding.conversationId, 'cli-42');
  assert.equal(binding.matchedPrefixLength, -1);
});

test('binding is disabled when affinity is off', () => {
  updateConfig({ runtime: { enableConversationAffinity: false } });
  try {
    const binding = getConversationBinding(reqWithHeaders(), [{ role: 'user', content: 'y' }]);
    assert.equal(binding.conversationId, null);
    assert.equal(getConversationId(reqWithHeaders(), [{ role: 'user', content: 'y' }]), null);
  } finally {
    updateConfig({ runtime: { enableConversationAffinity: true } });
  }
});
