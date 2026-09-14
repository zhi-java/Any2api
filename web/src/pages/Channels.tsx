import { useState } from 'react';
import { api } from '../lib/api';
import { usePolling } from '../lib/hooks';
import { Badge, Card, EmptyState, PanelHeader, Skeleton, StatusBadge } from '../components/ui';
import { MetricCard, MetricGrid } from '../components/Metric';
import type { ChannelId } from '../types';

const CAPABILITIES = [
  ['text', '文本'],
  ['thinking', '思考'],
  ['search', '搜索'],
  ['document', '文件'],
  ['vision', '图像'],
  ['audio', '音频'],
] as const;

export function ChannelsPage() {
  const [filter, setFilter] = useState<'all' | ChannelId>('all');
  const { data, loading } = usePolling(
    async () => {
      const [channels, models] = await Promise.all([api.getChannels(), api.getModels()]);
      return { channels: channels.channels ?? [], models: models.models ?? [] };
    },
    12_000,
  );

  if (loading && !data) {
    return (
      <div className="grid gap-3">
        <Skeleton className="h-24" />
        <Skeleton className="h-72" />
      </div>
    );
  }

  const channels = data?.channels ?? [];
  const models = data?.models ?? [];
  const visibleChannels = filter === 'all' ? channels : channels.filter(c => c.id === filter);
  const visibleModels = filter === 'all' ? models : models.filter(m => m.channel === filter);

  return (
    <div className="grid gap-4">
      <MetricGrid>
        <MetricCard label="健康" value={channels.filter(c => c.status === 'healthy').length} hint="可接受请求" tone="ok" />
        <MetricCard label="降级" value={channels.filter(c => c.status === 'degraded').length} hint="需要关注" tone="warn" />
        <MetricCard label="未配置" value={channels.filter(c => c.status === 'unconfigured').length} hint="尚未接入" />
        <MetricCard label="模型" value={models.length} hint="本地目录" />
      </MetricGrid>

      <Card className="py-3">
        <select
          value={filter}
          onChange={event => setFilter(event.target.value as 'all' | ChannelId)}
          className="min-h-[38px] rounded-xl border border-line-strong bg-surface px-3 text-sm outline-none focus:border-accent"
          aria-label="筛选渠道"
        >
          <option value="all">全部渠道</option>
          <option value="deepseek">DeepSeek</option>
        </select>
      </Card>

      <Card>
        <PanelHeader title="渠道" hint={`${visibleChannels.length} 项`} />
        {visibleChannels.length ? (
          <div className="overflow-x-auto">
            <table className="w-full border-collapse text-sm">
              <thead>
                <tr className="text-left text-[12px] font-semibold text-ink-3">
                  <th className="border-b border-line py-2 pr-3">渠道</th>
                  <th className="border-b border-line py-2 pr-3">状态</th>
                  <th className="border-b border-line py-2 pr-3">凭据</th>
                  <th className="border-b border-line py-2 pr-3">并发</th>
                  <th className="border-b border-line py-2">错误</th>
                </tr>
              </thead>
              <tbody>
                {visibleChannels.map(channel => (
                  <tr key={channel.id}>
                    <td className="border-b border-line py-3 pr-3">
                      <strong>{channel.name || channel.id}</strong>
                      <small className="block text-[12px] text-ink-3">{channel.mode}</small>
                    </td>
                    <td className="border-b border-line py-3 pr-3">
                      <StatusBadge status={channel.status} />
                    </td>
                    <td className="tabular border-b border-line py-3 pr-3">
                      {channel.availableCount || 0}/{channel.credentialCount || 0}
                    </td>
                    <td className="tabular border-b border-line py-3 pr-3">
                      {channel.activeRequests || 0}/{channel.capacity || 0}
                    </td>
                    <td className="tabular border-b border-line py-3">{channel.usage?.errors || 0}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <EmptyState title="无渠道数据" />
        )}
      </Card>

      <Card>
        <PanelHeader title="模型" hint={`${visibleModels.length} 项`} />
        {visibleModels.length ? (
          <div className="overflow-x-auto">
            <table className="w-full border-collapse text-sm">
              <thead>
                <tr className="text-left text-[12px] font-semibold text-ink-3">
                  <th className="border-b border-line py-2 pr-3">模型</th>
                  <th className="border-b border-line py-2 pr-3">渠道</th>
                  <th className="border-b border-line py-2">能力</th>
                </tr>
              </thead>
              <tbody>
                {visibleModels.map(model => (
                  <tr key={model.id}>
                    <td className="border-b border-line py-3 pr-3">
                      <code className="font-mono text-[13px]">{model.id}</code>
                    </td>
                    <td className="border-b border-line py-3 pr-3 text-ink-2">{model.channel || model.owned_by}</td>
                    <td className="border-b border-line py-3">
                      <div className="flex flex-wrap gap-1.5">
                        {CAPABILITIES.map(([key, label]) => (
                          <Badge key={key} tone={model.capabilities?.[key] ? 'accent' : 'muted'}>
                            {label}
                          </Badge>
                        ))}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <EmptyState title="没有匹配的模型" />
        )}
      </Card>
    </div>
  );
}
