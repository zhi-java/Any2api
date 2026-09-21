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
  Skeleton,
  useToast,
} from './ui';
import { useConfirm } from './ConfirmDialog';
import { formatRemaining } from '../lib/format';
import type { ChannelId, ChannelTestResult } from '../types';

/**
 * 凭据管理面板。
 *
 * 从原独立的「凭据」页抽出，供「渠道与凭据」页复用：渠道与凭据管理的是
 * 同一批资源（渠道 = 某上游接入方式，凭据 = 该渠道的账号/token），
 * 拆成两个平级页面会让用户困惑该去哪一页。
 */

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

interface CredentialRow {
  id: string;
  label?: string;
  email?: string;
  disabled?: boolean;
  disabledReason?: string;
  disabledRemainingMs?: number;
  disabledSource?: 'auto' | 'manual' | null;
  /** 运行时：是否已持有 token */
  hasToken?: boolean;
  /** 运行时：已配置但尚未取得 token 且未禁用 */
  pending?: boolean;
}

function credentialsFor(config: Record<string, unknown>): CredentialRow[] {
  const tokens = (config.tokens as CredentialRow[]) ?? [];
  const accounts = (config.accounts as CredentialRow[]) ?? [];
  return [...tokens, ...accounts];
}

export function CredentialsPanel({ channel }: { channel: ChannelId }) {
  const toast = useToast();
  const { confirm, dialog: confirmDialog } = useConfirm();
  const [config, setConfig] = useState<Record<string, unknown> | null>(null);
  const [type, setType] = useState<'token' | 'account'>('token');
  const [token, setToken] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<ChannelTestResult | null>(null);
  const [filter, setFilter] = useState<'all' | 'active' | 'pending' | 'disabled'>('all');
  const [showDisabled, setShowDisabled] = useState(true);
  const [elapsedSec, setElapsedSec] = useState(0);

  const load = useCallback(async () => {
    const result = await api.getChannelConfig(channel);
    setConfig(result.config);
  }, [channel]);

  useEffect(() => {
    setConfig(null);
    setType('token');
    setFilter('all');
    void load();
  }, [load]);

  const meta = CHANNEL_META[channel];
  const allRows = credentialsFor(config ?? {});

  // 三态统计，与「渠道概览」使用同一口径（都来自服务端的运行时注解）：
  //   可用   = 已持有 token 且未禁用 —— 真正能参与调度
  //   待登录 = 已配置但尚无 token 且未禁用（账号模式下需先登录）
  //   已禁用 = 被风控/人工标记禁用
  // 旧实现只按"是否标记禁用"统计，把"待登录"也算作可用，导致与概览对不上。
  const availableCount = allRows.filter(r => !r.disabled && r.hasToken).length;
  const pendingCount = allRows.filter(r => !r.disabled && !r.hasToken).length;
  const disabledCount = allRows.filter(r => r.disabled).length;

  // 筛选优先；未筛选且禁用项折叠时，把禁用项从主列表隐藏（但仍然计数），
  // 避免风控批量禁用时（实测一次 8 个）列表被禁用项淹没、可用的反而难找。
  const rows = allRows.filter(row => {
    if (filter === 'active') return !row.disabled && row.hasToken;
    if (filter === 'pending') return !row.disabled && !row.hasToken;
    if (filter === 'disabled') return Boolean(row.disabled);
    return showDisabled ? true : !row.disabled;
  });

  const isAccountPool =
    channel === 'deepseek' && config?.authMode === 'account-pool' && Number(config?.tokenCount ?? 0) > 0;

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
      await load();
    } catch (error) {
      toast(error instanceof Error ? error.message : '保存失败', 'danger');
    }
  }

  async function remove(id: string) {
    // 删除是不可逆的：凭据本身与禁用记录都会被清掉，风控结束后无法恢复。
    // 用结构化对话框把"后果"与"替代方案"讲清楚，而不是塞进原生弹窗一行文本。
    const ok = await confirm({
      title: '删除这个凭据？',
      tone: 'danger',
      confirmLabel: '删除',
      detail: (
        <div className="grid gap-2">
          <p className="m-0">
            删除后该凭据会从配置中移除，<strong className="text-ink">风控结束也无法恢复</strong>。
          </p>
          <p className="m-0 rounded-xl border border-line bg-subtle p-3 text-[13px]">
            如果只是暂时停用（例如账号被风控），请改用<strong className="text-ink">「禁用」</strong>——
            凭据会保留在列表中，可随时启用或等待自动恢复。
          </p>
        </div>
      ),
    });
    if (!ok) return;
    try {
      await api.removeCredential(channel, id);
      toast('凭据已删除', 'success');
      await load();
    } catch (error) {
      toast(error instanceof Error ? error.message : '删除失败', 'danger');
    }
  }

  async function toggleDisabled(row: CredentialRow) {
    const next = !row.disabled;
    try {
      await api.setCredentialDisabled(channel, row.id, next);
      toast(next ? '凭据已禁用（仍保留在配置中，可随时启用）' : '凭据已启用', next ? 'warning' : 'success');
      await load();
    } catch (error) {
      toast(error instanceof Error ? error.message : '操作失败', 'danger');
    }
  }

  async function test() {
    setTesting(true);
    // 测试是单次请求、后端逐个打上游，凭据多时可达数秒。显示已用时长，
    // 让用户知道"还在跑"而不是"卡住了"——原先只有按钮文字变化。
    setElapsedSec(0);
    const startedAt = Date.now();
    const ticker = window.setInterval(() => {
      setElapsedSec(Math.floor((Date.now() - startedAt) / 1000));
    }, 1000);
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
        await load();
      }
    } catch (error) {
      toast(error instanceof Error ? error.message : '测试失败', 'danger');
    } finally {
      window.clearInterval(ticker);
      setTesting(false);
      setElapsedSec(0);
    }
  }

  if (!config) {
    return (
      <div className="grid gap-4 lg:grid-cols-[1.3fr_1fr]">
        <Skeleton className="h-64" />
        <Skeleton className="h-64" />
      </div>
    );
  }

  return (
    <>
      <div className="grid gap-4 lg:grid-cols-[1.3fr_1fr]">
        <Card>
          <PanelHeader
            title={`${meta.name} 凭据`}
            hint={[
              `${availableCount} 可用`,
              pendingCount ? `${pendingCount} 待登录` : null,
              disabledCount ? `${disabledCount} 已禁用` : null,
            ].filter(Boolean).join(' · ')}
            action={
              <Button size="sm" variant="secondary" onClick={test} disabled={testing}>
                {testing ? `测试中… ${elapsedSec}s` : '测试渠道'}
              </Button>
            }
          />

          {/* 测什么、要等多久：该操作会逐个向上游校验每个凭据，凭据多时较慢。 */}
          {testing ? (
            <p className="mb-3 text-[12px] text-ink-3" role="status">
              正在逐个向上游校验凭据，数量较多时可能需要十几秒，请勿关闭页面。
            </p>
          ) : null}

          {/* 状态筛选：禁用项较多时（风控批量禁用）快速聚焦到可用凭据。 */}
          {allRows.length > 0 ? (
            <div className="mb-3 flex flex-wrap items-center gap-2">
              {(
                [
                  ['all', `全部 ${allRows.length}`],
                  ['active', `可用 ${availableCount}`],
                  ['pending', `待登录 ${pendingCount}`],
                  ['disabled', `已禁用 ${disabledCount}`],
                ] as const
              ).map(([key, label]) => (
                <button
                  key={key}
                  type="button"
                  onClick={() => setFilter(key)}
                  aria-pressed={filter === key}
                  className={`cursor-pointer rounded-full border px-3 py-1 text-[12px] font-semibold transition ${
                    filter === key
                      ? 'border-line-accent bg-accent-soft text-accent'
                      : 'border-line bg-surface text-ink-2 hover:text-ink'
                  }`}
                >
                  {label}
                </button>
              ))}
              {filter === 'all' && disabledCount > 0 ? (
                <button
                  type="button"
                  onClick={() => setShowDisabled(v => !v)}
                  className="ml-auto cursor-pointer text-[12px] font-semibold text-ink-2 underline-offset-2 hover:text-ink hover:underline"
                >
                  {showDisabled ? '折叠已禁用' : '展开已禁用'}
                </button>
              ) : null}
            </div>
          ) : null}
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
                    <th scope="col" className="border-b border-line py-2 pr-3">类型</th>
                    <th scope="col" className="border-b border-line py-2 pr-3">标识</th>
                    <th scope="col" className="border-b border-line py-2 pr-3">状态</th>
                    <th scope="col" className="border-b border-line py-2" />
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
                        ) : item.hasToken ? (
                          <Badge tone="ok">可用</Badge>
                        ) : (
                          // 已配置但尚未取得 token：账号型凭据需先登录才能参与调度。
                          // 直接显示"已启用"会与概览的可用数矛盾，也让人误以为可用。
                          <div className="grid gap-1">
                            <Badge tone="warn">待登录</Badge>
                            <small className="text-[12px] text-ink-3">尚未取得 token，不能参与调度</small>
                          </div>
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
            // 区分"从未添加"与"筛选后为空"：后者若也提示"暂无凭据"，
            // 会让人误以为数据丢了。
            <EmptyState
              title={allRows.length ? '没有符合筛选的凭据' : '暂无凭据'}
              detail={allRows.length ? '试试切换到其它筛选条件' : '在右侧添加 Token 或账号'}
            />
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
                  <th scope="col" className="border-b border-line py-2 pr-3">凭据</th>
                  <th scope="col" className="border-b border-line py-2 pr-3">结果</th>
                  <th scope="col" className="border-b border-line py-2">消息</th>
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

      {confirmDialog}
    </>
  );
}
