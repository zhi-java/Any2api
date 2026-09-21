import { Badge, Card, EmptyState, PanelHeader, Skeleton, StatusBadge } from '../components/ui';
import { MetricCard, MetricGrid } from '../components/Metric';
import { CredentialsPanel } from '../components/CredentialsPanel';
import { usePolling } from '../lib/hooks';
import { api } from '../lib/api';
import type { ChannelId } from '../types';

const CAPABILITIES = [
  ['text', '文本'],
  ['thinking', '思考'],
  ['search', '搜索'],
  ['document', '文件'],
  ['vision', '图像'],
  ['audio', '音频'],
] as const;

/**
 * 「渠道与凭据」页。
 *
 * 原先是两个平级页面（渠道 / 凭据），但它们管理的是同一批资源：渠道是上游
 * 接入方式，凭据是挂在该渠道下的 token/账号。分成两页会让用户反复猜测
 * "这件事该去哪一页"，也造成状态展示重复。现在合并为：上层渠道概览，
 * 下层即该渠道的凭据管理。
 */
export function ChannelsPage() {
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
  const activeChannel = (channels[0]?.id ?? 'deepseek') as ChannelId;

  return (
    <div className="grid gap-4">
      <MetricGrid>
        <MetricCard label="健康" value={channels.filter(c => c.status === 'healthy').length} hint="可接受请求" tone="ok" />
        <MetricCard label="降级" value={channels.filter(c => c.status === 'degraded').length} hint="需要关注" tone="warn" />
        <MetricCard label="未配置" value={channels.filter(c => c.status === 'unconfigured').length} hint="尚未接入" />
        <MetricCard label="模型" value={models.length} hint="本地目录" />
      </MetricGrid>

      <Card>
        <PanelHeader title="渠道概览" hint={`${channels.length} 项`} />
        {channels.length ? (
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
            {channels.map(channel => (
              <article
                key={channel.id}
                className={`grid gap-1.5 rounded-xl border p-4 ${
                  channel.status === 'healthy'
                    ? 'border-ok-line bg-ok-soft'
                    : channel.status === 'degraded'
                      ? 'border-warn/30 bg-warn-soft'
                      : 'border-line bg-subtle'
                }`}
              >
                <strong className="text-sm">{channel.name || channel.id}</strong>
                <span className="text-[12px] text-ink-2">
                  <strong className="text-ink">{channel.availableCount || 0}</strong>
                  /{channel.credentialCount || 0} 可用
                  {/* 待登录与禁用单列：只显示"5/10"而不解释差额会让人疑惑。
                      与「DeepSeek 凭据」面板使用同一套口径（可用/待登录/已禁用）。 */}
                  {Number(channel.pendingCount ?? 0) > 0 ? ` · ${Number(channel.pendingCount)} 待登录` : ''}
                  {Number(channel.disabledCount ?? 0) > 0 ? ` · ${Number(channel.disabledCount)} 已禁用` : ''}
                </span>
                <span className="text-[12px] text-ink-3">
                  并发 {channel.activeRequests || 0}/{channel.capacity || 0}
                </span>
                <div className="mt-1">
                  <StatusBadge status={channel.status} />
                </div>
              </article>
            ))}
          </div>
        ) : (
          <EmptyState title="无渠道数据" />
        )}
      </Card>

      <CredentialsPanel channel={activeChannel} />

      <Card>
        <PanelHeader title="模型" hint={`${models.length} 项`} />
        {models.length ? (
          <div className="overflow-x-auto">
            <table className="w-full border-collapse text-sm">
              <thead>
                <tr className="text-left text-[12px] font-semibold text-ink-3">
                  <th scope="col" className="border-b border-line py-2 pr-3">模型</th>
                  <th scope="col" className="border-b border-line py-2 pr-3">渠道</th>
                  <th scope="col" className="border-b border-line py-2">能力</th>
                </tr>
              </thead>
              <tbody>
                {models.map(model => (
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
