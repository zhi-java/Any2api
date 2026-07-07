import { emptyState, escapeHtml, showToast } from '../ui.js';

function formatCreatedAt(value) {
  if (!value) return '-';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '-';
  return date.toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
}

function renderKeyRows(config) {
  const keys = config.apiKeys || [];
  const legacyRow = config.adminKeyAcceptedForApi
    ? `<tr><td><strong>管理后台 Key</strong><small>来自 API_KEY，兼容旧客户端</small></td><td><code>${escapeHtml(config.apiKey || '-')}</code></td><td>${config.apiKeyConfigured ? '已启用' : '未配置'}</td><td><span class="badge badge-muted">系统</span></td></tr>`
    : '';
  const rows = keys.map(item => `<tr><td><strong>${escapeHtml(item.name || 'External API Key')}</strong><small>${escapeHtml(formatCreatedAt(item.createdAt))}</small></td><td><code>${escapeHtml(item.label || item.id)}</code></td><td>已启用</td><td><button class="btn btn-sm btn-danger" type="button" data-action="remove" data-id="${escapeHtml(item.id)}">删除</button></td></tr>`).join('');
  if (!legacyRow && !rows) return emptyState('暂无外部 API Key', '创建后即可用于 /v1/chat/completions、/v1/messages 和 /v1/responses');
  return `<table class="table"><thead><tr><th>名称</th><th>Key</th><th>状态</th><th></th></tr></thead><tbody>${legacyRow}${rows}</tbody></table>`;
}

function render(root, serverConfig, createdKey = '') {
  root.innerHTML = `
    <section class="hero-panel api-keys-hero">
      <div>
        <span class="hero-kicker">Access Control</span>
        <h2>对外 API Key</h2>
        <p>把调用方密钥从上游渠道凭据中拆出来管理。新 key 只在创建后显示一次，请立即保存到客户端环境变量。</p>
      </div>
      <div class="hero-stat"><span>可用 Key</span><strong>${serverConfig.externalApiKeyCount || 0}</strong></div>
    </section>
    ${createdKey ? `<section class="panel reveal-panel"><div class="panel-header"><h2>新 Key 已创建</h2><span>仅显示一次</span></div><div class="copy-strip"><code>${escapeHtml(createdKey)}</code><button class="btn btn-secondary" type="button" data-action="copy-created">复制</button></div></section>` : ''}
    <div class="content-grid two-columns">
      <section class="panel">
        <div class="panel-header"><h2>Key 列表</h2><span>${serverConfig.externalApiKeyCount || 0} 个可用</span></div>
        <div class="table-wrap">${renderKeyRows(serverConfig)}</div>
      </section>
      <section class="panel">
        <div class="panel-header"><h2>创建 Key</h2><span>自动生成高熵密钥</span></div>
        <form id="apiKeyForm" class="form-stack">
          <label class="field-label">名称</label>
          <input class="input" name="name" autocomplete="off" placeholder="例如：生产环境网关">
          <label class="field-label">自定义 Key（可选）</label>
          <input class="input" name="key" type="password" autocomplete="off" placeholder="留空自动生成 sk-omni-...">
          <button class="btn btn-primary" type="submit">创建外部 Key</button>
        </form>
      </section>
    </div>
  `;
}

export async function renderApiKeys(root, { API }) {
  root.innerHTML = '<div class="page-loading">加载 API Key...</div>';
  let serverConfig = {};
  let createdKey = '';

  async function loadConfig() {
    const result = await API.getConfig();
    serverConfig = result.config?.server || {};
    render(root, serverConfig, createdKey);
    bindEvents();
  }

  function bindEvents() {
    root.querySelector('#apiKeyForm')?.addEventListener('submit', async event => {
      event.preventDefault();
      const form = event.currentTarget;
      const data = new FormData(form);
      try {
        const result = await API.createServerApiKey({
          name: data.get('name'),
          key: data.get('key'),
        });
        createdKey = result.key || '';
        serverConfig = result.config || serverConfig;
        showToast('外部 API Key 已创建', 'success');
        render(root, serverConfig, createdKey);
        bindEvents();
      } catch (error) {
        showToast(error.message, 'danger');
      }
    });

    root.querySelectorAll('[data-action="remove"]').forEach(button => {
      button.addEventListener('click', async () => {
        if (!confirm('确定删除这个外部 API Key？正在使用它的客户端会立即失效。')) return;
        try {
          const result = await API.removeServerApiKey(button.dataset.id);
          createdKey = '';
          serverConfig = result.config || serverConfig;
          showToast('外部 API Key 已删除', 'success');
          render(root, serverConfig, createdKey);
          bindEvents();
        } catch (error) {
          showToast(error.message, 'danger');
        }
      });
    });

    root.querySelector('[data-action="copy-created"]')?.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(createdKey);
        showToast('已复制', 'success');
      } catch {
        showToast('复制失败，请手动选择 Key', 'danger');
      }
    });
  }

  await loadConfig();
  return () => {};
}
