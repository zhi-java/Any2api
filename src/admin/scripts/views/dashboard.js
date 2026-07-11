import PollingManager from '../polling.js';
import { escapeHtml, formatNumber, statusBadge, skeletonCards, showToast } from '../ui.js';

function healthWord(status) {
  if (status === 'healthy') return { text: '运行中', cls: 'is-ok' };
  if (status === 'degraded') return { text: '需关注', cls: 'is-warn' };
  if (status === 'unavailable') return { text: '不可用', cls: 'is-bad' };
  return { text: '检查中', cls: '' };
}

function channelCardClass(status) {
  if (status === 'healthy') return 'is-healthy';
  if (status === 'degraded') return 'is-degraded';
  return 'is-idle';
}

function channelMeta(channel) {
  const available = channel.availableCount || 0;
  const total = channel.credentialCount || 0;
  if (channel.status === 'healthy') return `健康 · ${available}/${total || available} 凭据`;
  if (channel.status === 'degraded') return `降级 · 需关注 · ${available}/${total} 凭据`;
  if (channel.status === 'unconfigured' || total === 0) return '未配置 · 去添加凭据';
  return `${channel.status || '未知'} · ${available}/${total} 凭据`;
}

async function copyText(text) {
  if (!text) throw new Error('没有可复制的地址');
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
    return;
  }
  const input = document.createElement('textarea');
  input.value = text;
  input.setAttribute('readonly', '');
  input.style.position = 'fixed';
  input.style.opacity = '0';
  document.body.appendChild(input);
  input.select();
  document.execCommand('copy');
  input.remove();
}

export async function renderDashboard(root, { API }) {
  root.innerHTML = `${skeletonCards(4)}<section class="panel skeleton-panel"></section>`;
  let mounted = false;
  let endpointCopyInFlight = false;

  function renderShell(stats) {
    const channels = stats.channels || [];
    const health = healthWord(stats.status || (channels.some(c => c.status === 'healthy') ? 'healthy' : 'unavailable'));
    const endpoint = stats.serverUrl ? `${stats.serverUrl}/v1` : '/v1';

    root.innerHTML = `
      <div class="compact-page dashboard-workbench">
        <div class="home-hero-grid">
          <section class="home-service-card">
            <div class="home-service-head">
              <div>
                <div class="label">服务状态</div>
                <div class="status-word ${health.cls}" data-metric="healthWord">${health.text}</div>
              </div>
              <button
                type="button"
                class="service-toggle"
                data-action="toggle-display"
                aria-checked="true"
                title="网关进程由服务端管理；此处展示运行态"
              ></button>
            </div>
            <div class="endpoint-well">
              <code data-metric="endpoint">${escapeHtml(endpoint)}</code>
              <button type="button" class="btn btn-primary btn-sm" data-action="copy-endpoint">复制 API 地址</button>
            </div>
            <div class="protocol-chip-row" aria-label="支持的 API 协议">
              <span class="protocol-chip">OpenAI Chat <code>/v1/chat/completions</code></span>
              <span class="protocol-chip">Anthropic <code>/v1/messages</code></span>
              <span class="protocol-chip">OpenAI Responses <code>/v1/responses</code></span>
            </div>
            <div class="home-chip-row">
              <span class="badge badge-success" data-metric="healthyChip">0 渠道健康</span>
              <span class="badge badge-warning" data-metric="degradedChip">0 渠道降级</span>
              <span class="badge badge-muted" data-metric="queueChip">队列 0</span>
            </div>
          </section>

          <section class="home-steps-card">
            <div class="panel-header" style="margin-bottom:12px">
              <h2>开始使用</h2>
              <span data-metric="stepsHint">引导</span>
            </div>
            <div class="step-list" data-steps></div>
            <div style="display:flex;gap:8px;margin-top:14px;flex-wrap:wrap;">
              <a class="btn btn-secondary btn-sm" href="#credentials">添加凭据</a>
              <a class="btn btn-ghost btn-sm" href="#channels">查看渠道</a>
              <a class="btn btn-ghost btn-sm" href="#performance">打开监控</a>
            </div>
          </section>
        </div>

        <div class="metric-grid compact-grid">
          <article class="metric-card">
            <span>今日请求</span>
            <strong data-metric="total">0</strong>
            <small data-metric="last5min">最近 5 分钟 0</small>
          </article>
          <article class="metric-card">
            <span>成功率</span>
            <strong data-metric="successRate">0.0%</strong>
            <small data-metric="successCount">0 成功</small>
          </article>
          <article class="metric-card">
            <span>平均延迟</span>
            <strong data-metric="latency">-</strong>
            <small data-metric="latencyHint">P50 / 首包</small>
          </article>
          <article class="metric-card">
            <span>可用账号</span>
            <strong data-metric="available">0</strong>
            <small data-metric="healthyChannels">0 个健康渠道</small>
          </article>
        </div>

        <section class="panel compact-panel">
          <div class="panel-header">
            <h2>渠道概览</h2>
            <span data-metric="channelCount">${channels.length} 个渠道</span>
          </div>
          <div class="channel-card-grid" data-channel-cards></div>
        </section>
      </div>
    `;

    mounted = true;
  }

  function setText(selector, value) {
    const node = root.querySelector(selector);
    if (node) node.textContent = value;
  }

  function renderSteps(stats) {
    const channels = stats.channels || [];
    const hasCreds = channels.some(c => (c.credentialCount || 0) > 0 || (c.availableCount || 0) > 0);
    const hasHealthy = channels.some(c => c.status === 'healthy');
    const steps = [
      {
        title: '添加渠道凭据',
        detail: hasCreds ? '已配置至少一个上游账号' : '前往「凭据」粘贴 Token 或账密',
        state: hasCreds ? 'is-done' : 'is-current',
      },
      {
        title: '确认渠道健康',
        detail: hasHealthy ? '至少一条渠道可用' : '配置后等待健康检查或去渠道页测试',
        state: hasHealthy ? 'is-done' : (hasCreds ? 'is-current' : ''),
      },
      {
        title: '复制 API 地址到客户端',
        detail: '',
        state: hasHealthy ? 'is-current' : '',
      },
    ];

    const done = steps.filter(s => s.state === 'is-done').length;
    setText('[data-metric="stepsHint"]', `${done}/${steps.length} 完成`);

    const host = root.querySelector('[data-steps]');
    if (!host) return;
    host.innerHTML = steps.map((step, index) => `
      <div class="step-item ${step.state}">
        <span class="step-index">${step.state === 'is-done' ? '✓' : index + 1}</span>
        <div>
          <strong>${escapeHtml(step.title)}</strong>
          ${step.detail ? `<small>${escapeHtml(step.detail)}</small>` : ''}
        </div>
      </div>
    `).join('');
  }

  function updateView(stats) {
    const channels = stats.channels || [];
    const total = stats.logStats?.totalRequests || 0;
    const success = stats.logStats?.successCount || 0;
    const successRate = total > 0 ? ((success / total) * 100).toFixed(1) : '0.0';
    const available = channels.reduce((sum, item) => sum + (item.availableCount || 0), 0);
    const healthyCount = channels.filter(c => c.status === 'healthy').length;
    const degradedCount = channels.filter(c => c.status === 'degraded').length;
    const endpoint = stats.serverUrl ? `${stats.serverUrl}/v1` : `${location.origin}/v1`;
    const health = healthWord(
      stats.healthStatus
      || (healthyCount > 0 ? (degradedCount > 0 ? 'degraded' : 'healthy') : (channels.length ? 'unavailable' : 'unconfigured'))
    );
    const ttfb = stats.metrics?.ttfbP50;
    const latencyText = ttfb == null || ttfb === 0 ? '-' : (ttfb < 1000 ? `${ttfb}ms` : `${(ttfb / 1000).toFixed(1)}s`);

    if (!mounted) {
      renderShell({
        ...stats,
        status: health.cls === 'is-ok' ? 'healthy' : health.cls === 'is-warn' ? 'degraded' : 'unavailable',
      });
    }

    const word = root.querySelector('[data-metric="healthWord"]');
    if (word) {
      word.textContent = health.text;
      word.className = `status-word ${health.cls}`;
    }

    const toggle = root.querySelector('[data-action="toggle-display"]');
    if (toggle) {
      const on = health.cls !== 'is-bad';
      toggle.classList.toggle('is-off', !on);
      toggle.setAttribute('aria-checked', on ? 'true' : 'false');
    }

    setText('[data-metric="endpoint"]', endpoint);
    setText('[data-metric="healthyChip"]', `${healthyCount} 渠道健康`);
    setText('[data-metric="degradedChip"]', `${degradedCount} 渠道降级`);
    setText('[data-metric="queueChip"]', `队列 ${stats.queue?.queued || 0}/${stats.queue?.maxQueueSize || 0}`);
    setText('[data-metric="total"]', formatNumber(total));
    setText('[data-metric="last5min"]', `最近 5 分钟 ${formatNumber(stats.logStats?.last5min || 0)}`);
    setText('[data-metric="successRate"]', `${successRate}%`);
    setText('[data-metric="successCount"]', `${formatNumber(success)} 成功`);
    setText('[data-metric="latency"]', latencyText);
    setText('[data-metric="latencyHint"]', ttfb ? 'P50 首包延迟' : '暂无采样');
    setText('[data-metric="available"]', available);
    setText('[data-metric="healthyChannels"]', `${healthyCount} 个健康渠道`);
    setText('[data-metric="channelCount"]', `${channels.length} 个渠道`);

    const cards = root.querySelector('[data-channel-cards]');
    if (cards) {
      if (!channels.length) {
        cards.innerHTML = `<div class="empty-state" style="min-height:96px;grid-column:1/-1"><strong>暂无渠道</strong><span>检查服务配置</span></div>`;
      } else {
        cards.innerHTML = channels.map(channel => `
          <article class="channel-card ${channelCardClass(channel.status)}">
            <strong>${escapeHtml(channel.name || channel.id)}</strong>
            <div class="meta">${escapeHtml(channelMeta(channel))}</div>
            <div style="margin-top:10px">${statusBadge(channel.status)}</div>
          </article>
        `).join('');
      }
    }

    renderSteps(stats);
  }

  async function update() {
    updateView(await API.getStats());
  }

  async function handleCopyClick(event) {
    const btn = event.target.closest('[data-action="copy-endpoint"]');
    if (!btn) return;
    if (endpointCopyInFlight) return;

    endpointCopyInFlight = true;
    const buttons = root.querySelectorAll('[data-action="copy-endpoint"]');
    buttons.forEach(node => { node.disabled = true; });

    const endpoint = root.querySelector('[data-metric="endpoint"]')?.textContent?.trim();
    try {
      await copyText(endpoint);
      showToast('已复制 API 地址', 'success');
    } catch (error) {
      showToast(error.message || '复制失败，请手动选择 API 地址', 'danger');
    } finally {
      endpointCopyInFlight = false;
      buttons.forEach(node => { node.disabled = false; });
    }
  }

  root.addEventListener('click', handleCopyClick);

  const polling = new PollingManager(10000);
  polling.start(update);
  return () => {
    root.removeEventListener('click', handleCopyClick);
    polling.stop();
  };
}
