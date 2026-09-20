import { useEffect, useRef, useState } from 'react';
import { Chart, type ChartConfiguration } from 'chart.js/auto';
import { api } from '../lib/api';
import { usePolling } from '../lib/hooks';
import { formatDuration } from '../lib/format';
import { Card, PanelHeader } from '../components/ui';
import { MetricCard, MetricGrid } from '../components/Metric';
import type { TimeseriesPoint } from '../types';

const RANGES = ['1h', '3h', '6h', '12h', '24h', '48h', '72h'];
const COLORS = { primary: '#4f46e5', ok: '#10b981', warn: '#f59e0b', bad: '#ef4444', info: '#6366f1' };

interface Series {
  label: string;
  color: string;
  data: number[];
}

function timeLabels(points: TimeseriesPoint[]): string[] {
  return points.map(point => {
    const value = point.ts ?? point.t ?? point.time;
    const date = new Date(value as string | number);
    return Number.isNaN(date.getTime())
      ? ''
      : date.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
  });
}

function lineConfig(): ChartConfiguration<'line'> {
  return {
    type: 'line',
    data: { labels: [], datasets: [] },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: { duration: 120 },
      interaction: { intersect: false, mode: 'index' },
      plugins: { legend: { display: false } },
      scales: {
        x: { grid: { display: false }, ticks: { color: '#64748b', maxTicksLimit: 6 } },
        y: { beginAtZero: true, grid: { color: 'rgba(148,163,184,0.25)' }, ticks: { color: '#64748b' } },
      },
    },
  };
}

/** 图表画布：首次挂载建实例，之后只更新 data，避免轮询重建。 */
function ChartCard({ title, labels, series }: { title: string; labels: string[]; series: Series[] }) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const chartRef = useRef<Chart | null>(null);

  useEffect(() => {
    if (!canvasRef.current) return;
    chartRef.current = new Chart(canvasRef.current, lineConfig());
    return () => chartRef.current?.destroy();
  }, []);

  useEffect(() => {
    const chart = chartRef.current;
    if (!chart) return;
    chart.data.labels = labels;
    chart.data.datasets = series.map(item => ({
      label: item.label,
      data: item.data,
      borderColor: item.color,
      backgroundColor: `${item.color}22`,
      fill: true,
      tension: 0.25,
      pointRadius: 0,
    }));
    chart.update('none');
  }, [labels, series]);

  return (
    <Card>
      <PanelHeader title={title} hint={series.length > 1 ? series.map(s => s.label).join(' / ') : undefined} />
      <div className="h-[220px]">
        <canvas ref={canvasRef} />
      </div>
    </Card>
  );
}

export function PerformancePage() {
  const [range, setRange] = useState('6h');
  const metrics = usePolling(() => api.getMetrics(), 15_000);
  const series = usePolling(() => api.getTimeseries(range), 15_000);
  // 容量/会话/对话这些状态后端一直在返回，但界面从未展示——排障时
  // "池子还能扛多少并发""会话缓存命中如何"都需要它们。
  const stats = usePolling(() => api.getStats(), 15_000);

  const points = series.data?.points ?? [];
  const labels = timeLabels(points);
  const m = metrics.data ?? {};

  const chartSeries: { title: string; series: Series[] }[] = [
    { title: 'RPM', series: [{ label: 'RPM', color: COLORS.primary, data: points.map(p => p.rpm ?? 0) }] },
    {
      title: '首字延迟',
      series: [
        { label: 'P50', color: COLORS.ok, data: points.map(p => p.ttfbP50 ?? 0) },
        { label: 'P90', color: COLORS.warn, data: points.map(p => p.ttfbP90 ?? 0) },
      ],
    },
    { title: 'Token 速度', series: [{ label: 'Token/s', color: COLORS.info, data: points.map(p => p.tokenSpeed ?? 0) }] },
    { title: '错误率', series: [{ label: '错误率', color: COLORS.bad, data: points.map(p => p.errorRate ?? 0) }] },
  ];

  return (
    <div className="grid gap-4">
      <MetricGrid>
        <MetricCard label="RPM" value={m.rpm ?? 0} hint="请求/分钟" />
        <MetricCard label="首字 P50" value={formatDuration(m.ttfbP50)} hint="中位延迟" />
        <MetricCard label="Token 速度" value={m.tokenSpeed ?? 0} hint="tok/s" />
        <MetricCard label="错误率" value={`${m.errorRate ?? 0}%`} hint="近期请求" />
      </MetricGrid>

      <MetricGrid>
        <MetricCard
          label="并发容量"
          value={stats.data?.totalCapacity ?? 0}
          hint={`当前在途 ${stats.data?.channels?.reduce((s, c) => s + (c.activeRequests || 0), 0) ?? 0}`}
        />
        <MetricCard
          label="会话缓存"
          value={stats.data?.sessions?.count ?? 0}
          hint={`TTL ${stats.data?.sessions?.ttl ?? 0}s`}
        />
        <MetricCard
          label="队列"
          value={stats.data?.queue?.queued ?? 0}
          hint={`上限 ${stats.data?.queue?.maxQueueSize ?? 0}`}
          tone={stats.data && stats.data.queue.queued > 0 ? 'warn' : undefined}
        />
        <MetricCard
          label="对话亲和"
          value={stats.data?.conversations?.affinityEnabled ? '已启用' : '未启用'}
          hint={stats.data?.conversations?.active != null ? `${stats.data.conversations.active} 个活跃对话` : '运行时开关'}
        />
      </MetricGrid>

      <Card className="py-3">
        <div className="flex flex-wrap gap-1.5">
          {RANGES.map(item => (
            <button
              key={item}
              type="button"
              onClick={() => setRange(item)}
              className={`cursor-pointer rounded-xl px-3 py-1.5 text-[13px] font-bold transition ${
                item === range ? 'bg-accent text-white' : 'bg-subtle text-ink-2 hover:text-ink'
              }`}
            >
              {item}
            </button>
          ))}
        </div>
      </Card>

      <div className="grid gap-4 xl:grid-cols-2">
        {chartSeries.map(item => (
          <ChartCard key={item.title} title={item.title} labels={labels} series={item.series} />
        ))}
      </div>
    </div>
  );
}
