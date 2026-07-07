import PollingManager from '../polling.js';
import { formatDurationMs } from '../ui.js';

let range = '6h';

function timeLabels(points) {
  return points.map(point => {
    const value = point.ts || point.t || point.time;
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return '';
    return date.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
  });
}

function dataset(label, color, data) {
  return { label, data, borderColor: color, backgroundColor: `${color}22`, fill: true, tension: .25, pointRadius: 0 };
}

function createLine(canvas, labels, datasets) {
  return new Chart(canvas, {
    type: 'line',
    data: { labels, datasets },
    options: window.ZhiCharts?.lineOptions?.() || { responsive: true, maintainAspectRatio: false },
  });
}

function updateChart(chart, labels, datasets) {
  chart.data.labels = labels;
  chart.data.datasets = datasets;
  chart.update('none');
}

export async function renderPerformance(root, { API }) {
  root.innerHTML = '<div class="page-loading">加载性能数据...</div>';
  let charts = [];
  let mounted = false;

  function destroyCharts() {
    charts.forEach(chart => chart.destroy());
    charts = [];
  }

  function renderShell() {
    root.innerHTML = `
      <div class="metric-grid">
        <article class="metric-card"><span>RPM</span><strong data-metric="rpm">0</strong><small>请求/分钟</small></article>
        <article class="metric-card"><span>首字 P50</span><strong data-metric="ttfbP50">0ms</strong><small>中位延迟</small></article>
        <article class="metric-card"><span>Token 速度</span><strong data-metric="tokenSpeed">0</strong><small>tok/s</small></article>
        <article class="metric-card"><span>错误率</span><strong data-metric="errorRate">0%</strong><small>近期请求</small></article>
      </div>
      <section class="panel">
        <div class="panel-header"><h2>时间范围</h2><div class="segmented-control" id="rangeControl">${['1h','3h','6h','12h','24h','48h','72h'].map(item => `<button class="segment ${item === range ? 'active' : ''}" type="button" data-range="${item}">${item}</button>`).join('')}</div></div>
      </section>
      <div class="content-grid two-columns">
        <section class="panel"><div class="panel-header"><h2>RPM</h2></div><div class="chart-frame"><canvas id="rpmChart"></canvas></div></section>
        <section class="panel"><div class="panel-header"><h2>首字延迟</h2></div><div class="chart-frame"><canvas id="latencyChart"></canvas></div></section>
        <section class="panel"><div class="panel-header"><h2>Token 速度</h2></div><div class="chart-frame"><canvas id="speedChart"></canvas></div></section>
        <section class="panel"><div class="panel-header"><h2>错误率</h2></div><div class="chart-frame"><canvas id="errorChart"></canvas></div></section>
      </div>
    `;
    const colors = window.ZhiCharts?.CHART_THEME?.colors || {};
    charts = [
      createLine(root.querySelector('#rpmChart'), [], [dataset('RPM', colors.primary || '#007aff', [])]),
      createLine(root.querySelector('#latencyChart'), [], [dataset('P50', colors.success || '#0a8f5a', []), dataset('P90', colors.warning || '#b87500', [])]),
      createLine(root.querySelector('#speedChart'), [], [dataset('Token/s', colors.info || '#5e5ce6', [])]),
      createLine(root.querySelector('#errorChart'), [], [dataset('错误率', colors.error || '#d92d20', [])]),
    ];
    root.querySelectorAll('[data-range]').forEach(button => {
      button.addEventListener('click', () => {
        range = button.dataset.range;
        root.querySelectorAll('[data-range]').forEach(item => item.classList.toggle('active', item.dataset.range === range));
        update();
      });
    });
    mounted = true;
  }

  function setText(selector, value) {
    const node = root.querySelector(selector);
    if (node) node.textContent = value;
  }

  async function update() {
    const [metrics, series] = await Promise.all([
      API.getMetrics(),
      API.getTimeseries({ range }),
    ]);
    const points = series.points || [];
    const labels = timeLabels(points);
    if (!mounted) renderShell();

    setText('[data-metric="rpm"]', metrics.rpm || 0);
    setText('[data-metric="ttfbP50"]', formatDurationMs(metrics.ttfbP50 || 0));
    setText('[data-metric="tokenSpeed"]', metrics.tokenSpeed || 0);
    setText('[data-metric="errorRate"]', `${metrics.errorRate || 0}%`);

    const colors = window.ZhiCharts?.CHART_THEME?.colors || {};
    updateChart(charts[0], labels, [dataset('RPM', colors.primary || '#007aff', points.map(point => point.rpm || 0))]);
    updateChart(charts[1], labels, [dataset('P50', colors.success || '#0a8f5a', points.map(point => point.ttfbP50 || 0)), dataset('P90', colors.warning || '#b87500', points.map(point => point.ttfbP90 || 0))]);
    updateChart(charts[2], labels, [dataset('Token/s', colors.info || '#5e5ce6', points.map(point => point.tokenSpeed || 0))]);
    updateChart(charts[3], labels, [dataset('错误率', colors.error || '#d92d20', points.map(point => point.errorRate || 0))]);
  }

  const polling = new PollingManager(15000);
  polling.start(update);
  return () => {
    polling.stop();
    destroyCharts();
  };
}
