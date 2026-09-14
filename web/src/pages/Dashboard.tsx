import { api } from '../lib/api';
import { usePolling } from '../lib/hooks';
import { copyText, formatDuration, formatNumber } from '../lib/format';
import { Badge, Button, Card, EmptyState, PanelHeader, Skeleton, StatusBadge, useToast } from '../components/ui';
import { MetricCard, MetricGrid } from '../components/Metric';

/** 首页：大目标优先 —— 服务状态 → 端点 → 引导清单 → KPI → 渠道卡片。 */
export function DashboardPage() {
  const toast = useToast();
  const { data, loading, refresh } = usePolling(() => api.getStats(), 10_000);

  if (loading && !data) {
    return (
      <div className="grid gap-3">
        <MetricGrid>
          <Skeleton className="h-24" />
          <Skeleton className="h-24" />
          <Skeleton className="h-24" />
          <Skeleton className="h-24" />
        </MetricGrid>
        <Skeleton className="h-64" />
      </div>
    );
  }

  if (!data) {
    return <EmptyState title="无法读取服务状态" detail="请确认服务已启动并可访问" />;
  }

  const channels = data.channels ?? [];
  const healthy = channels.filter(c => c.status === 'healthy').length;
  const degraded = channels.filter(c => c.status === 'degraded').length;
  const total = data.logStats?.totalRequests ?? 0;
  const success = data.logStats?.successCount ?? 0;
  const successRate = total > 0 ? ((success / total) * 100).toFixed(1) : '0.0';
  const available = channels.reduce((sum, c) => sum + (c.availableCount || 0), 0);
  const endpoint = `${data.serverUrl || window.location.origin}/v1`;

  const statusWord =
    healthy > 0 ? (degraded > 0 ? '需关注' : '运行中') : channels.length ? '不可用' : '未配置';
  const statusTone = healthy > 0 ? (degraded > 0 ? 'is-warn' : 'is-ok') : 'is-bad';

  const hasCreds = channels.some(c => (c.credentialCount || 0) > 0 || (c.availableCount || 0) > 0);
  const steps = [
    {
      title: '添加渠道凭据',
      detail: hasCreds ? '已配置至少一个上游凭据' : '前往「凭据」粘贴 Token 或账密',
      done: hasCreds,
    },
    { title: '确认渠道健康', detail: healthy > 0 ? '至少一条渠道可用' : '配置后等待健康检查或去渠道页测试', done: healthy > 0 },
    { title: '复制 API 地址到客户端', detail: '把下方端点地址填入你的 OpenAI / Claude 客户端', done: healthy > 0 },
  ];
  const doneCount = steps.filter(s => s.done).length;

  return (
    <div className="grid gap-4">
      <div className="grid gap-3 lg:grid-cols-[1.35fr_1fr]">
        <Card className="grid content-start gap-4">
          <div className="flex items-start justify-between gap-3">
            <div className="grid gap-1">
              <span className="text-[12px] font-semibold text-ink-2">服务状态</span>
              <strong
                className={`text-[28px] font-extrabold tracking-[-0.02em] ${
                  statusTone === 'is-ok' ? 'text-ok' : statusTone === 'is-warn' ? 'text-warn-ink' : 'text-bad'
                }`}
              >
                {statusWord}
              </strong>
            </div>
            <Badge tone="muted">自动托管</Badge>
          </div>

          <div className="endpoint-well flex items-center justify-between gap-3 p-3">
            <code className="overflow-x-auto whitespace-nowrap font-mono text-[13px] text-ink">{endpoint}</code>
            <Button
              size="sm"
              onClick={async () => {
                try {
                  await copyText(endpoint);
                  toast('已复制 API 地址', 'success');
                } catch (error) {
                  toast(error instanceof Error ? error.message : '复制失败，请手动选择地址', 'danger');
                }
              }}
            >
              复制 API 地址
            </Button>
          </div>

          <div className="flex flex-wrap gap-2">
            {[
              ['OpenAI Chat', '/v1/chat/completions'],
              ['Anthropic', '/v1/messages'],
              ['OpenAI Responses', '/v1/responses'],
            ].map(([name, path]) => (
              <span key={path} className="rounded-full border border-line bg-subtle px-3 py-1 text-[12px] text-ink-2">
                {name} <code className="font-mono text-ink-3">{path}</code>
              </span>
            ))}
          </div>

          <div className="flex flex-wrap gap-2">
            <Badge tone="ok">{healthy} 渠道健康</Badge>
            <Badge tone="warn">{degraded} 渠道降级</Badge>
            <Badge tone="muted">
              队列 {data.queue?.queued ?? 0}/{data.queue?.maxQueueSize ?? 0}
            </Badge>
          </div>
        </Card>

        <Card className="grid content-start gap-3">
          <PanelHeader title="开始使用" hint={`${doneCount}/${steps.length} 完成`} />
          <div className="grid gap-2">
            {steps.map((step, index) => (
              <div
                key={step.title}
                className={`flex items-start gap-3 rounded-xl border p-3 ${
                  step.done ? 'border-ok-line bg-ok-soft' : 'border-line bg-subtle'
                }`}
              >
                <span
                  className={`grid h-6 w-6 shrink-0 place-items-center rounded-full text-[12px] font-bold ${
                    step.done ? 'bg-ok text-white' : 'bg-line text-ink-2'
                  }`}
                >
                  {step.done ? '✓' : index + 1}
                </span>
                <div className="grid gap-0.5">
                  <strong className="text-sm text-ink">{step.title}</strong>
                  <small className="text-[12px] text-ink-2">{step.detail}</small>
                </div>
              </div>
            ))}
          </div>
          <div className="flex flex-wrap gap-2">
            <a href="#credentials">
              <Button size="sm" variant="secondary">
                添加凭据
              </Button>
            </a>
            <a href="#channels">
              <Button size="sm" variant="ghost">
                查看渠道
              </Button>
            </a>
            <Button size="sm" variant="ghost" onClick={() => void refresh()}>
              刷新
            </Button>
          </div>
        </Card>
      </div>

      <MetricGrid>
        <MetricCard label="今日请求" value={formatNumber(total)} hint={`最近 5 分钟 ${formatNumber(data.logStats?.last5min ?? 0)}`} />
        <MetricCard label="成功率" value={`${successRate}%`} hint={`${formatNumber(success)} 成功`} tone={Number(successRate) >= 99 ? 'ok' : undefined} />
        <MetricCard label="首字 P50" value={formatDuration(data.metrics?.ttfbP50)} hint="P50 首包延迟" />
        <MetricCard label="可用账号" value={available} hint={`${healthy} 个健康渠道`} />
      </MetricGrid>

      <Card>
        <PanelHeader title="渠道概览" hint={`${channels.length} 个渠道`} />
        {channels.length ? (
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
            {channels.map(channel => (
              <article
                key={channel.id}
                className={`grid gap-1.5 rounded-2xl border p-4 ${
                  channel.status === 'healthy'
                    ? 'border-ok-line bg-ok-soft'
                    : channel.status === 'degraded'
                      ? 'border-warn/30 bg-warn-soft'
                      : 'border-line bg-subtle'
                }`}
              >
                <strong className="text-sm">{channel.name || channel.id}</strong>
                <span className="text-[12px] text-ink-2">
                  {channel.status === 'healthy'
                    ? `健康 · ${channel.availableCount}/${channel.credentialCount || channel.availableCount} 凭据`
                    : channel.status === 'degraded'
                      ? `降级 · 需关注 · ${channel.availableCount}/${channel.credentialCount} 凭据`
                      : '未配置 · 去添加凭据'}
                </span>
                <div className="mt-1.5">
                  <StatusBadge status={channel.status} />
                </div>
              </article>
            ))}
          </div>
        ) : (
          <EmptyState title="暂无渠道" detail="检查服务配置" />
        )}
      </Card>
    </div>
  );
}
