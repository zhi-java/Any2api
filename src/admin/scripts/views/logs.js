import PollingManager from '../polling.js';
import { debounce, emptyState, escapeHtml, formatTime } from '../ui.js';

let filters = { count: '60', channel: 'all', status: 'all', search: '' };

function render(root, logs) {
  root.innerHTML = `
    <section class="panel filter-panel">
      <div class="filter-bar">
        <select id="logCount" class="select filter-item">
          <option value="30">30 条</option>
          <option value="60">60 条</option>
          <option value="100">100 条</option>
          <option value="200">200 条</option>
        </select>
        <select id="channelFilter" class="select filter-item">
          <option value="all">全部渠道</option>
          <option value="deepseek">DeepSeek</option>
          <option value="glm">GLM</option>
          <option value="qwen">Qwen</option>
          <option value="kimi">Kimi</option>
        </select>
        <select id="statusFilter" class="select filter-item">
          <option value="all">全部状态</option>
          <option value="success">成功</option>
          <option value="error">错误</option>
        </select>
        <input id="logSearch" class="input filter-item" type="search" placeholder="搜索日志" value="${escapeHtml(filters.search)}">
      </div>
    </section>
    <section class="panel logs-panel">
      <div class="panel-header"><h2>近期日志</h2><span>${logs.length} 条</span></div>
      <div class="log-list">
        ${logs.length ? logs.map(log => `<article class="log-row log-${escapeHtml(String(log.level || 'info').toLowerCase())}"><time>${escapeHtml(formatTime(log.time))}</time><strong>${escapeHtml(log.level || '')}</strong><span>${escapeHtml(log.message || '')}</span></article>`).join('') : emptyState('暂无日志')}
      </div>
    </section>
  `;

  root.querySelector('#logCount').value = filters.count;
  root.querySelector('#channelFilter').value = filters.channel;
  root.querySelector('#statusFilter').value = filters.status;
}

export async function renderLogs(root, { API }) {
  root.innerHTML = '<div class="page-loading">加载日志...</div>';
  let logs = [];

  async function update() {
    const result = await API.getLogs(filters.count, {
      channel: filters.channel,
      status: filters.status,
      search: filters.search,
      model: 'all',
    });
    logs = result.logs || [];
    render(root, logs);
    bindEvents();
  }

  const debouncedUpdate = debounce(update, 250);

  function bindEvents() {
    root.querySelector('#logCount')?.addEventListener('change', event => {
      filters.count = event.target.value;
      update();
    });
    root.querySelector('#channelFilter')?.addEventListener('change', event => {
      filters.channel = event.target.value;
      update();
    });
    root.querySelector('#statusFilter')?.addEventListener('change', event => {
      filters.status = event.target.value;
      update();
    });
    root.querySelector('#logSearch')?.addEventListener('input', event => {
      filters.search = event.target.value.trim();
      debouncedUpdate();
    });
  }

  const polling = new PollingManager(10000);
  polling.start(update);
  return () => polling.stop();
}
