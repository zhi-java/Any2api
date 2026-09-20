import { useEffect, useRef, useState } from 'react';
import { Chart, type ChartConfiguration } from 'chart.js/auto';
import { api } from '../lib/api';
import { usePolling } from '../lib/hooks';
import { formatDuration } from '../lib/format';
import { Card, PanelHeader } from '../components/ui';
import { MetricCard, MetricGrid } from '../components/Metric';
import type { TimeseriesPoint } from '../types';

const RANGES = ['1h', '3h', '6h', '12h', '24h', '48h', '72h'];

/**
 * 图表配色从设计 token 读取，不再硬编码 hex。
 *
 * 原因：原先这里重复定义了一份与 index.css 相同的色值，改 token 时图表不会
 * 跟着变，长期必然漂移。chart.js 需要具体色值而非 CSS 变量引用，因此在运行时
 * 读取计算后的变量值；变量缺失时回落到同样的字面量，保证不退化为不可见。
 */
function tokenColor(name: string, fallback: string): string {
  if (typeof window === 'undefined') return fallback;
  const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return value || fallback;
}

function chartColors() {
  return {
    primary: tokenColor('--color-accent', '#4f46e5'),
    // 图表线条属于大块图形，用亮色即可（文字才需要 -ink 深色变体）。
    ok: tokenColor('--color-ok', '#10b981'),
    warn: tokenColor('--color-warn', '#f59e0b'),
    bad: tokenColor('--color-bad', '#ef4444'),
    info: tokenColor('--color-info', '#6366f1'),
    // 坐标轴文字用小号字，需要满足对比度：用 ink-2 而非更浅的 ink-3。
    axis: tokenColor('--color-ink-2', '#475569'),
    grid: tokenColor('--color-line', '#e2e8f0'),
  };
}

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
  const c = chartColors();
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
        x: { grid: { display: false }, ticks: { color: c.axis, maxTicksLimit: 6 } },
        y: { beginAtZero: true, grid: { color: c.grid }, ticks: { color: c.axis } },
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
  // 在渲染时读取 token：模块加载时读会早于样式生效，拿不到值。
  const colors = chartColors();

  const chartSeries: { title: string; series: Series[] }[] = [
    { title: 'RPM', series: [{ label: 'RPM', color: colors.primary, data: points.map(p => p.rpm ?? 0) }] },
    {
      title: '首字延迟',
      series: [
        { label: 'P50', color: colors.ok, data: points.map(p => p.ttfbP50 ?? 0) },
        { label: 'P90', color: colors.warn, data: points.map(p => p.ttfbP90 ?? 0) },
      ],
    },
    { title: 'Token 速度', series: [{ label: 'Token/s', color: colors.info, data: points.map(p => p.tokenSpeed ?? 0) }] },
    { title: '错误率', series: [{ label: '错误率', color: colors.bad, data: points.map(p => p.errorRate ?? 0) }] },
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
