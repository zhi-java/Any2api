import { useCallback, useEffect, useState } from 'react';
import { api } from '../lib/api';
import {
  Badge,
  Button,
  Card,
  EmptyState,
  Field,
  Input,
  Modal,
  PanelHeader,
  Select,
  useToast,
} from '../components/ui';
import { formatRemaining } from '../lib/format';
import type { ChannelId, ChannelTestResult } from '../types';

interface ChannelMeta {
  name: string;
  modes: ('token' | 'account')[];
  tokenLabel: string;
  tokenHint: string;
  accountHint?: string;
}

const CHANNEL_META: Record<ChannelId, ChannelMeta> = {
  deepseek: {
    name: 'DeepSeek',
    modes: ['token', 'account'],
    tokenLabel: 'userToken',
    tokenHint: '来源：Local Storage → userToken',
    accountHint: '账号模式使用上游网页登录账号/密码。如遇验证码或风控，优先使用 Token/Cookie 模式。',
  },
};

const CHANNEL_IDS: ChannelId[] = ['deepseek'];

interface CredentialRow {
  id: string;
  label?: string;
  email?: string;
  disabled?: boolean;
  disabledReason?: string;
  disabledRemainingMs?: number;
  disabledSource?: 'auto' | 'manual' | null;
}

function credentialsFor(channel: ChannelId, config: Record<string, unknown>): CredentialRow[] {
  if (channel === 'deepseek') {
    const tokens = (config.tokens as CredentialRow[]) ?? [];
    const accounts = (config.accounts as CredentialRow[]) ?? [];
    return [...tokens, ...accounts];
  }
  return (config.refreshTokens as CredentialRow[]) ?? [];
}

export function CredentialsPage() {
  const toast = useToast();
  const [channel, setChannel] = useState<ChannelId>('deepseek');
  const [configs, setConfigs] = useState<Partial<Record<ChannelId, Record<string, unknown>>>>({});
  const [type, setType] = useState<'token' | 'account'>('token');
  const [token, setToken] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<ChannelTestResult | null>(null);

  const loadConfigs = useCallback(async () => {
    const entries = await Promise.all(
      CHANNEL_IDS.map(async id => {
        const result = await api.getChannelConfig(id);
        return [id, result.config] as const;
      }),
    );
    setConfigs(Object.fromEntries(entries));
  }, []);

  useEffect(() => {
    void loadConfigs();
  }, [loadConfigs]);

  const meta = CHANNEL_META[channel];
  const config = configs[channel] ?? {};
  const rows = credentialsFor(channel, config);
  const isAccountPool = channel === 'deepseek' && config.authMode === 'account-pool' && Number(config.tokenCount ?? 0) > 0;

  async function save(event: React.FormEvent) {
    event.preventDefault();
    try {
      if (type === 'account') {
        await api.addCredential(channel, { type: 'account', email, password });
        setEmail('');
        setPassword('');
      } else {
        const trimmed = token.trim();
        if (!trimmed) {
          toast('请先填写 Token', 'warning');
          return;
        }
        await api.addCredential(channel, { type: 'token', token: trimmed });
        setToken('');
      }
      toast('凭据已保存', 'success');
      await loadConfigs();
    } catch (error) {
      toast(error instanceof Error ? error.message : '保存失败', 'danger');
    }
  }

  async function remove(id: string) {
    // 删除是不可逆的：凭据本身与禁用记录都会被清掉，风控结束后无法恢复。
    // 因此提示里明确引导用户优先考虑"禁用"。
    if (!window.confirm('确定删除这个凭据？删除后配置将被移除、无法恢复。\n如需临时停用，请改用「禁用」。')) return;
    try {
      await api.removeCredential(channel, id);
      toast('凭据已删除', 'success');
      await loadConfigs();
    } catch (error) {
      toast(error instanceof Error ? error.message : '删除失败', 'danger');
    }
  }

  async function toggleDisabled(row: CredentialRow) {
    const next = !row.disabled;
    try {
      await api.setCredentialDisabled(channel, row.id, next);
      toast(next ? '凭据已禁用（仍保留在配置中，可随时启用）' : '凭据已启用', next ? 'warning' : 'success');
      await loadConfigs();
    } catch (error) {
      toast(error instanceof Error ? error.message : '操作失败', 'danger');
    }
  }

  async function test() {
    setTesting(true);
    try {
      const result = await api.testChannel(channel);
      setTestResult(result);
      // 无效凭据改为"禁用"而非删除：它仍留在列表中，只是标记为禁用状态。
      if (result.disabled) {
        toast(
          result.disabledCount
            ? `失效凭据已禁用（共 ${result.disabledCount} 个），可在列表中启用或删除`
            : '失效凭据已禁用，可在列表中启用或删除',
          'warning',
        );
        await loadConfigs();
      }
    } catch (error) {
      toast(error instanceof Error ? error.message : '测试失败', 'danger');
    } finally {
      setTesting(false);
    }
  }

  return (
    <div className="grid gap-4">
      <div className="flex flex-wrap gap-2">
        {CHANNEL_IDS.map(id => (
          <button
            key={id}
            type="button"
            onClick={() => {
              setChannel(id);
              setType('token');
            }}
            className={`rounded-xl border px-4 py-2 text-sm font-bold transition ${
              id === channel
                ? 'border-line-accent bg-accent-soft text-accent'
                : 'border-line bg-surface text-ink-2 hover:text-ink'
            }`}
          >
            {CHANNEL_META[id].name}
          </button>
        ))}
      </div>

      <div className="grid gap-4 lg:grid-cols-[1.25fr_1fr]">
        <Card>
          <PanelHeader
            title={`${meta.name} 凭据`}
            hint={
              Number(config.disabledCount ?? 0) > 0
                ? `${Number(config.disabledCount)} 个已禁用`
                : undefined
            }
            action={
              <Button size="sm" variant="secondary" onClick={test} disabled={testing}>
                {testing ? '测试中…' : '测试渠道'}
              </Button>
            }
          />
          {isAccountPool ? (
            <div className="mb-3 rounded-xl border border-line bg-subtle p-3 text-[12px] text-ink-2">
              <strong className="block text-ink">Token 已隐藏</strong>
              当前使用 DS_ACCOUNTS 账号池，{Number(config.tokenCount ?? 0)} 个运行时 token 不在后台展示。
            </div>
          ) : null}
          {rows.length ? (
            <div className="overflow-x-auto">
              <table className="w-full border-collapse text-sm">
                <thead>
                  <tr className="text-left text-[12px] font-semibold text-ink-3">
                    <th className="border-b border-line py-2 pr-3">类型</th>
                    <th className="border-b border-line py-2 pr-3">标识</th>
                    <th className="border-b border-line py-2 pr-3">状态</th>
                    <th className="border-b border-line py-2" />
                  </tr>
                </thead>
                <tbody>
                  {rows.map(item => (
                    <tr key={item.id}>
                      <td className="border-b border-line py-3 pr-3 text-ink-2">{item.email ? '账号' : 'Token'}</td>
                      <td className="border-b border-line py-3 pr-3">
                        <code className="font-mono text-[13px]">{item.email || item.label || item.id}</code>
                      </td>
                      <td className="border-b border-line py-3 pr-3">
                        {item.disabled ? (
                          <div className="grid gap-1">
                            <Badge tone={item.disabledSource === 'manual' ? 'muted' : 'warn'}>
                              {item.disabledSource === 'manual' ? '已禁用（手动）' : '已禁用'}
                            </Badge>
                            <small className="text-[12px] text-ink-3">
                              {item.disabledReason || '未知原因'}
                              {item.disabledRemainingMs
                                ? ` · ${formatRemaining(item.disabledRemainingMs)}`
                                : ' · 不自动恢复'}
                            </small>
                          </div>
                        ) : (
                          <Badge tone="ok">已启用</Badge>
                        )}
                      </td>
                      <td className="border-b border-line py-3 text-right">
                        <div className="flex justify-end gap-2">
                          <Button size="sm" variant="secondary" onClick={() => void toggleDisabled(item)}>
                            {item.disabled ? '启用' : '禁用'}
                          </Button>
                          <Button size="sm" variant="danger" onClick={() => void remove(item.id)}>
                            删除
                          </Button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <EmptyState title="暂无凭据" detail="在右侧添加" />
          )}
        </Card>

        <Card>
          <PanelHeader title="添加凭据" hint="保存后仅显示掩码" />
          <form onSubmit={save} className="grid gap-3">
            {meta.modes.includes('account') ? (
              <Field label="类型">
                <Select value={type} onChange={event => setType(event.target.value as 'token' | 'account')}>
                  <option value="token">Token</option>
                  <option value="account">账号</option>
                </Select>
              </Field>
            ) : null}

            {type === 'token' ? (
              <Field label={`Token（${meta.tokenLabel}）`} hint={meta.tokenHint}>
                <Input
                  type="password"
                  autoComplete="off"
                  placeholder={`粘贴 ${meta.tokenLabel}`}
                  value={token}
                  onChange={event => setToken(event.target.value)}
                />
              </Field>
            ) : (
              <>
                <Field label="邮箱 / 账号">
                  <Input
                    type="email"
                    autoComplete="off"
                    placeholder="上游网页登录邮箱或账号"
                    value={email}
                    onChange={event => setEmail(event.target.value)}
                  />
                </Field>
                <Field label="密码" hint={meta.accountHint}>
                  <Input
                    type="password"
                    autoComplete="off"
                    placeholder="上游网页登录密码"
                    value={password}
                    onChange={event => setPassword(event.target.value)}
                  />
                </Field>
              </>
            )}

            <Button type="submit">保存</Button>
          </form>
        </Card>
      </div>

      {testResult ? (
        <Modal
          title={`${meta.name} 测试结果`}
          hint={`${testResult.results.filter(r => r.success).length}/${testResult.results.length} 通过`}
          onClose={() => setTestResult(null)}
          footer={
            <Button variant="secondary" onClick={() => setTestResult(null)}>
              关闭
            </Button>
          }
        >
          <div className="overflow-x-auto">
            <table className="w-full border-collapse text-sm">
              <thead>
                <tr className="text-left text-[12px] font-semibold text-ink-3">
                  <th className="border-b border-line py-2 pr-3">凭据</th>
                  <th className="border-b border-line py-2 pr-3">结果</th>
                  <th className="border-b border-line py-2">消息</th>
                </tr>
              </thead>
              <tbody>
                {testResult.results.map((item, index) => (
                  <tr key={`${item.label}-${index}`}>
                    <td className="border-b border-line py-3 pr-3">
                      <code className="font-mono text-[13px]">{item.label}</code>
                    </td>
                    <td className="border-b border-line py-3 pr-3">
                      <Badge tone={item.success ? 'ok' : 'bad'}>{item.success ? '通过' : '失败'}</Badge>
                    </td>
                    <td className="border-b border-line py-3 text-ink-2">{item.message}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Modal>
      ) : null}
    </div>
  );
}
