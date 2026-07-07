import PollingManager from '../polling.js';
import { escapeHtml, formatNumber, statusBadge, skeletonCards } from '../ui.js';

export async function renderDashboard(root, { API }) {
  root.innerHTML = `${skeletonCards(4)}<section class="panel skeleton-panel"></section>`;
  const history = { labels: [], values: [] };
  let chart = null;
  let mounted = false;

  function renderShell(stats) {
    const channels = stats.channels || [];
    root.innerHTML = `
      <div class="metric-grid">
        <article class="metric-card"><span>请求总数</span><strong data-metric="total">0</strong><small data-metric="last5min">0 / 5 分钟</small></article>
        <article class="metric-card"><span>成功率</span><strong data-metric="successRate">0.0%</strong><small data-metric="successCount">0 成功</small></article>
        <article class="metric-card"><span>可用凭据</span><strong data-metric="available">0</strong><small data-metric="healthyChannels">0 个健康渠道</small></article>
        <article class="metric-card"><span>队列</span><strong data-metric="queued">0</strong><small data-metric="queueCapacity">容量 0</small></article>
      </div>
      <div class="content-grid two-columns">
        <section class="panel">
          <div class="panel-header"><h2>请求趋势</h2><span>实时</span></div>
          <div class="chart-frame"><canvas id="requestTrend"></canvas></div>
        </section>
        <section class="panel">
          <div class="panel-header"><h2>渠道状态</h2><span data-metric="channelCount">${channels.length} 个渠道</span></div>
          <div class="table-wrap" data-channel-table></div>
        </section>
      </div>
    `;

    chart = new Chart(root.querySelector('#requestTrend'), {
      type: 'line',
      data: {
        labels: history.labels,
        datasets: [{
          label: '请求',
          data: history.values,
          borderColor: window.ZhiCharts?.CHART_THEME?.colors?.primary || '#007aff',
          backgroundColor: 'rgba(0, 122, 255, .10)',
          fill: true,
          tension: .25,
          pointRadius: 0,
        }],
      },
      options: window.ZhiCharts?.lineOptions?.() || { responsive: true, maintainAspectRatio: false },
    });
    mounted = true;
  }

  function setText(selector, value) {
    const node = root.querySelector(selector);
    if (node) node.textContent = value;
  }

  function updateView(stats) {
    const channels = stats.channels || [];
    const total = stats.logStats?.totalRequests || 0;
    const success = stats.logStats?.successCount || 0;
    const successRate = total > 0 ? ((success / total) * 100).toFixed(1) : '0.0';
    const available = channels.reduce((sum, item) => sum + (item.availableCount || 0), 0);

    if (!mounted) renderShell(stats);

    setText('[data-metric="total"]', formatNumber(total));
    setText('[data-metric="last5min"]', `${formatNumber(stats.logStats?.last5min || 0)} / 5 分钟`);
    setText('[data-metric="successRate"]', `${successRate}%`);
    setText('[data-metric="successCount"]', `${formatNumber(success)} 成功`);
    setText('[data-metric="available"]', available);
    setText('[data-metric="healthyChannels"]', `${channels.filter(channel => channel.status === 'healthy').length} 个健康渠道`);
    setText('[data-metric="queued"]', stats.queue?.queued || 0);
    setText('[data-metric="queueCapacity"]', `容量 ${stats.queue?.maxQueueSize || 0}`);
    setText('[data-metric="channelCount"]', `${channels.length} 个渠道`);
    setText('[data-endpoint]', `${stats.serverUrl || ''}/v1/chat/completions`);

    const table = root.querySelector('[data-channel-table]');
    if (table) {
      table.innerHTML = `
        <table class="table">
          <thead><tr><th>渠道</th><th>状态</th><th>凭据</th><th>RPM</th><th>错误</th></tr></thead>
          <tbody>${channels.map(channel => `<tr><td><strong>${escapeHtml(channel.name || channel.id)}</strong></td><td>${statusBadge(channel.status)}</td><td>${channel.availableCount || 0}/${channel.credentialCount || 0}</td><td>${channel.usage?.rpm || 0}</td><td class="${(channel.usage?.errors || 0) > 0 ? 'text-danger' : 'text-success'}">${channel.usage?.errors || 0}</td></tr>`).join('')}</tbody>
        </table>`;
    }

    const now = new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
    history.labels.push(now);
    history.values.push(total);
    if (history.labels.length > 20) {
      history.labels.shift();
      history.values.shift();
    }
    if (chart) {
      chart.data.labels = history.labels;
      chart.data.datasets[0].data = history.values;
      chart.update('none');
    }
  }

  async function update() {
    updateView(await API.getStats());
  }

  const polling = new PollingManager(10000);
  polling.start(update);
  return () => {
    polling.stop();
    if (chart) chart.destroy();
  };
}
