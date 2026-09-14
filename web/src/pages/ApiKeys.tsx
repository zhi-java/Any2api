import { useCallback, useEffect, useState } from 'react';
import { api } from '../lib/api';
import { copyText, formatDateTime } from '../lib/format';
import { Badge, Button, Card, EmptyState, Field, Input, PanelHeader, useToast } from '../components/ui';
import type { ServerConfig } from '../types';

/** 外部 API Key 管理：创建（自动生成高熵密钥）/ 复制 / 删除。 */
export function ApiKeysPage() {
  const toast = useToast();
  const [server, setServer] = useState<ServerConfig | null>(null);
  const [createdKey, setCreatedKey] = useState('');
  const [name, setName] = useState('');
  const [customKey, setCustomKey] = useState('');
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const result = await api.getConfig();
    setServer(result.config.server);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  if (!server) return <EmptyState title="加载中…" />;

  async function create(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    try {
      const result = await api.createServerApiKey({ name, key: customKey });
      setCreatedKey(result.key ?? '');
      setServer(result.config);
      setName('');
      setCustomKey('');
      toast('外部 API Key 已创建', 'success');
    } catch (error) {
      toast(error instanceof Error ? error.message : '创建失败', 'danger');
    } finally {
      setBusy(false);
    }
  }

  async function remove(id: string) {
    if (!window.confirm('确定删除这个外部 API Key？正在使用它的客户端会立即失效。')) return;
    try {
      const result = await api.removeServerApiKey(id);
      setCreatedKey('');
      setServer(result.config);
      toast('外部 API Key 已删除', 'success');
    } catch (error) {
      toast(error instanceof Error ? error.message : '删除失败', 'danger');
    }
  }

  return (
    <div className="grid gap-4 lg:grid-cols-[1.25fr_1fr]">
      <Card>
        <PanelHeader title="Key 列表" hint={`${server.externalApiKeyCount || 0} 个可用`} />
        {server.adminKeyAcceptedForApi || server.apiKeys.length ? (
          <div className="overflow-x-auto">
            <table className="w-full border-collapse text-sm">
              <thead>
                <tr className="text-left text-[12px] font-semibold text-ink-3">
                  <th className="border-b border-line py-2 pr-3">名称</th>
                  <th className="border-b border-line py-2 pr-3">Key</th>
                  <th className="border-b border-line py-2" />
                </tr>
              </thead>
              <tbody>
                {server.adminKeyAcceptedForApi ? (
                  <tr>
                    <td className="border-b border-line py-3 pr-3">
                      <strong className="block">管理后台 Key</strong>
                      <small className="text-[12px] text-ink-3">来自 API_KEY，兼容旧客户端</small>
                    </td>
                    <td className="border-b border-line py-3 pr-3">
                      <code className="font-mono text-[13px]">{server.apiKey || '-'}</code>
                    </td>
                    <td className="border-b border-line py-3 text-right">
                      <Badge tone="muted">系统</Badge>
                    </td>
                  </tr>
                ) : null}
                {server.apiKeys.map(item => (
                  <tr key={item.id}>
                    <td className="border-b border-line py-3 pr-3">
                      <strong className="block">{item.name || 'External API Key'}</strong>
                      <small className="text-[12px] text-ink-3">
                        {item.createdAt ? formatDateTime(item.createdAt) : '新建'}
                      </small>
                    </td>
                    <td className="border-b border-line py-3 pr-3">
                      <code className="font-mono text-[13px]">{item.label || item.id}</code>
                    </td>
                    <td className="border-b border-line py-3 text-right">
                      <Button size="sm" variant="danger" onClick={() => void remove(item.id)}>
                        删除
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <EmptyState
            title="暂无外部 API Key"
            detail="创建后即可用于 /v1/chat/completions、/v1/messages 和 /v1/responses"
          />
        )}
      </Card>

      <Card>
        <PanelHeader title="创建 Key" hint="自动生成高熵密钥" />
        {createdKey ? (
          <div className="mb-3 grid gap-2 rounded-xl border border-ok-line bg-ok-soft p-3">
            <span className="text-[12px] font-bold text-ok">新 Key 已创建 · 仅显示一次</span>
            <div className="flex items-center gap-2">
              <code className="min-w-0 flex-1 overflow-x-auto whitespace-nowrap font-mono text-[13px] text-ink">
                {createdKey}
              </code>
              <Button
                size="sm"
                variant="secondary"
                onClick={async () => {
                  try {
                    await copyText(createdKey);
                    toast('已复制', 'success');
                  } catch {
                    toast('复制失败，请手动选择 Key', 'danger');
                  }
                }}
              >
                复制
              </Button>
            </div>
          </div>
        ) : null}
        <form onSubmit={create} className="grid gap-3">
          <Field label="名称">
            <Input
              autoComplete="off"
              placeholder="例如：生产环境网关"
              value={name}
              onChange={event => setName(event.target.value)}
            />
          </Field>
          <Field label="自定义 Key（可选）">
            <Input
              type="password"
              autoComplete="off"
              placeholder="留空自动生成 sk-omni-..."
              value={customKey}
              onChange={event => setCustomKey(event.target.value)}
            />
          </Field>
          <Button type="submit" disabled={busy}>
            {busy ? '创建中…' : '创建外部 Key'}
          </Button>
        </form>
      </Card>
    </div>
  );
}
