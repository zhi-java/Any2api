import test from 'node:test';
import assert from 'node:assert/strict';

process.env.DS_TOKENS = 'test-token';
process.env.DS_ACCOUNTS = '';
process.env.DS_ACCOUNTS_EXTENDED = '';

const { buildPersistedTokenEnv, upsertEnvValues } = await import('../src/services/auth.js');

test('buildPersistedTokenEnv deduplicates tokens and records account token links', () => {
  const result = buildPersistedTokenEnv([
    { token: 'manual-token-123456', dead: false },
    { token: 'account-token-abcdef', email: 'user@example.com', password: 'p:ss', dead: false },
    { token: 'account-token-abcdef', email: 'user@example.com', password: 'p:ss', dead: false },
    { token: 'dead-token-abcdef', email: 'dead@example.com', password: 'pw', dead: true },
    { token: null, email: 'empty@example.com', password: 'pw', dead: false },
  ]);

  assert.deepEqual(result.dsTokens, [
    'manual-token-123456',
    'account-token-abcdef',
  ]);
  assert.deepEqual(result.dsAccountsExtended, [
    'user@example.com:p:ss:account-toke',
  ]);
});

test('upsertEnvValues replaces existing keys and appends missing keys', () => {
  const result = upsertEnvValues('A=1\nDS_TOKENS=
    DS_TOKENS: 'new-token',
    DS_ACCOUNTS_EXTENDED: 'user@example.com:pw:new-token-pr',
  });

  assert.equal(
    result,
    'A=1\nDS_TOKENS=
  );
});
