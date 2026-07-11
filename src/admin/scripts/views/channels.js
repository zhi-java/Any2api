import PollingManager from '../polling.js';
import { capabilityBadge, emptyState, escapeHtml, statusBadge } from '../ui.js';

let selectedChannel = 'all';

function modelCapabilities(model) {
  const cap = model.capabilities || {};
  return [
    capabilityBadge('文本', cap.text !== false),
    capabilityBadge('思考', Boolean(cap.thinking)),
    capabilityBadge('搜索', Boolean(cap.search)),
    capabilityBadge('文件', Boolean(cap.document)),
    capabilityBadge('图像', Boolean(cap.vision || cap.image_gen)),
    capabilityBadge('音频', Boolean(cap.audio)),
  ].join('');
}

function render(root, channels, models) {
  const visibleChannels = selectedChannel === 'all'
    ? channels
    : channels.filter(channel => channel.id === selectedChannel);
  const visibleModels = selectedChannel === 'all'
    ? models
    : models.filter(model => model.channel === selectedChannel);

  root.innerHTML = `
    <div class="compact-page channels-workbench">
      <div class="metric-grid compact-grid">
        <article class="metric-card"><span>健康</span><strong class="text-success">${channels.filter(channel => channel.status === 'healthy').length}</strong><small>可接受请求</small></article>
        <article class="metric-card"><span>降级</span><strong class="text-warning">${channels.filter(channel => channel.status === 'degraded').length}</strong><small>需要关注</small></article>
        <article class="metric-card"><span>未配置</span><strong>${channels.filter(channel => channel.status === 'unconfigured').length}</strong><small>尚未接入</small></article>
        <article class="metric-card"><span>模型</span><strong>${models.length}</strong><small>本地目录</small></article>
      </div>

      <section class="panel compact-panel channel-controls-panel">
        <div class="toolbar">
          <div class="toolbar-left channel-controls">
            <select id="channelFilter" class="select">
              <option value="all">全部渠道</option>
              <option value="deepseek">DeepSeek</option>
              <option value="glm">GLM</option>
              <option value="qwen">Qwen</option>
              <option value="kimi">Kimi</option>
            </select>
          </div>
        </div>
      </section>

      <div class="page-split-stack">
        <section class="panel compact-panel">
          <div class="panel-header"><h2>渠道</h2><span>${visibleChannels.length} 项</span></div>
          <div class="table-wrap">
            ${visibleChannels.length ? `<table class="table dense-table"><thead><tr><th>渠道</th><th>状态</th><th>凭据</th><th>并发</th><th>错误</th></tr></thead><tbody>${visibleChannels.map(channel => `<tr><td><strong>${escapeHtml(channel.name || channel.id)}</strong><small>${escapeHtml(channel.mode || '')}</small></td><td>${statusBadge(channel.status)}</td><td>${channel.availableCount || 0}/${channel.credentialCount || 0}</td><td>${channel.activeRequests || 0}/${channel.capacity || 0}</td><td>${channel.usage?.errors || 0}</td></tr>`).join('')}</tbody></table>` : emptyState('无渠道数据')}
          </div>
        </section>
        <section class="panel compact-panel">
          <div class="panel-header"><h2>模型</h2><span>${visibleModels.length} 项</span></div>
          <div class="table-wrap">
            ${visibleModels.length ? `<table class="table dense-table"><thead><tr><th>模型</th><th>渠道</th><th>能力</th></tr></thead><tbody>${visibleModels.map(model => `<tr><td><code>${escapeHtml(model.id)}</code></td><td>${escapeHtml(model.channel || model.owned_by || '-')}</td><td><div class="badge-line">${modelCapabilities(model)}</div></td></tr>`).join('')}</tbody></table>` : emptyState('没有匹配的模型')}
          </div>
        </section>
      </div>
    </div>
  `;

  const channelFilter = root.querySelector('#channelFilter');
  channelFilter.value = selectedChannel;
  channelFilter.addEventListener('change', () => {
    selectedChannel = channelFilter.value;
    render(root, channels, models);
  });
}

export async function renderChannels(root, { API }) {
  root.innerHTML = '<div class="page-loading">加载渠道...</div>';
  let channels = [];
  let models = [];

  async function update() {
    const [channelResult, modelResult] = await Promise.all([API.getChannels(), API.getModels()]);
    channels = channelResult.channels || [];
    models = modelResult.models || [];
    render(root, channels, models);
  }

  const polling = new PollingManager(12000);
  polling.start(update);
  return () => polling.stop();
}
