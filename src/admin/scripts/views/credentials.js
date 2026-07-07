import { emptyState, escapeHtml, showToast } from '../ui.js';

const channelMeta = {
  deepseek: { name: 'DeepSeek', modes: ['token', 'account'] },
  glm: { name: 'GLM', modes: ['token'] },
  qwen: { name: 'Qwen', modes: ['token', 'account'] },
  kimi: { name: 'Kimi', modes: ['token'] },
};

let activeChannel = 'deepseek';

function credentialsFor(channel, config) {
  if (channel === 'deepseek') return [...(config.tokens || []), ...(config.accounts || [])];
  if (channel === 'glm') return config.refreshTokens || [];
  if (channel === 'qwen') return [...(config.tokens || []), ...(config.accounts || [])];
  if (channel === 'kimi') return config.authTokens || [];
  return [];
}

function credentialLabel(item) {
  if (item.email) return item.email;
  return item.label || item.id || '-';
}

function credentialType(item) {
  if (item.email) return '账号';
  return 'Token';
}

function renderCredentialRows(channel, config) {
  const rows = credentialsFor(channel, config);
  const accountModeNote = channel === 'deepseek' && config.authMode === 'account-pool' && Number(config.tokenCount || 0) > 0
    ? `<div class="empty-state compact-state"><strong>Token 已隐藏</strong><span>当前使用 DS_ACCOUNTS 账号池，${Number(config.tokenCount || 0)} 个运行时 token 不在后台展示。</span></div>`
    : '';
  if (!rows.length) return accountModeNote || emptyState(channel === 'glm' && config.guestMode ? '访客模式已启用' : '暂无凭据');
  return `${accountModeNote}<table class="table"><thead><tr><th>类型</th><th>标识</th><th>状态</th><th></th></tr></thead><tbody>${rows.map(item => `<tr><td>${credentialType(item)}</td><td><code>${escapeHtml(credentialLabel(item))}</code></td><td><span class="badge badge-muted">已保存</span></td><td><button class="btn btn-sm btn-danger" data-action="remove" data-id="${escapeHtml(item.id)}">删除</button></td></tr>`).join('')}</tbody></table>`;
}

function render(root, configs) {
  const config = configs[activeChannel] || {};
  const meta = channelMeta[activeChannel];
  root.innerHTML = `
    <div class="tabs">${Object.entries(channelMeta).map(([id, item]) => `<button class="tab ${id === activeChannel ? 'active' : ''}" type="button" data-channel="${id}">${item.name}</button>`).join('')}</div>
    <div class="content-grid two-columns">
      <section class="panel">
        <div class="panel-header"><h2>${meta.name} 凭据</h2><button class="btn btn-secondary" type="button" data-action="test">测试渠道</button></div>
        <div class="table-wrap">${renderCredentialRows(activeChannel, config)}</div>
      </section>
      <section class="panel">
        <div class="panel-header"><h2>添加凭据</h2><span>保存后仅显示掩码</span></div>
        <form id="credentialForm" class="form-stack">
          ${meta.modes.includes('account') ? `<label class="field-label">类型</label><select class="select" name="type"><option value="token">Token</option><option value="account">账号</option></select>` : `<input type="hidden" name="type" value="token">`}
          <div data-token-fields>
            <label class="field-label">Token</label>
            <input class="input" name="token" type="password" autocomplete="off" placeholder="粘贴 Token">
          </div>
          ${meta.modes.includes('account') ? `<div data-account-fields hidden><label class="field-label">邮箱</label><input class="input" name="email" type="email" autocomplete="off"><label class="field-label">密码</label><input class="input" name="password" type="password" autocomplete="off"></div>` : ''}
          ${activeChannel === 'glm' ? `<label class="switch-row"><input type="checkbox" name="guestMode" ${config.guestMode ? 'checked' : ''}> 启用访客模式</label>` : ''}
          <button class="btn btn-primary" type="submit">保存</button>
        </form>
      </section>
    </div>
  `;
}

export async function renderCredentials(root, { API }) {
  root.innerHTML = '<div class="page-loading">加载凭据配置...</div>';
  const configs = {};

  async function loadConfigs() {
    for (const channel of Object.keys(channelMeta)) {
      const result = await API.getChannelConfig(channel);
      configs[channel] = result.config || {};
    }
    render(root, configs);
    bindEvents();
  }

  function bindEvents() {
    root.querySelectorAll('[data-channel]').forEach(button => {
      button.addEventListener('click', () => {
        activeChannel = button.dataset.channel;
        render(root, configs);
        bindEvents();
      });
    });

    const form = root.querySelector('#credentialForm');
    const typeSelect = form?.elements?.type;
    const tokenFields = root.querySelector('[data-token-fields]');
    const accountFields = root.querySelector('[data-account-fields]');

    typeSelect?.addEventListener('change', () => {
      const account = typeSelect.value === 'account';
      if (tokenFields) tokenFields.hidden = account;
      if (accountFields) accountFields.hidden = !account;
    });

    form?.addEventListener('submit', async event => {
      event.preventDefault();
      const data = new FormData(form);
      const type = data.get('type') || 'token';
      try {
        if (activeChannel === 'glm' && data.has('guestMode')) {
          await API.updateChannelConfig('glm', { ...configs.glm, guestMode: data.get('guestMode') === 'on' });
        }
        if (type === 'account') {
          await API.addCredential(activeChannel, { type: 'account', email: data.get('email'), password: data.get('password') });
        } else {
          const token = String(data.get('token') || '').trim();
          if (token) {
            const payload = activeChannel === 'glm' ? { type: 'token', refreshToken: token } : { type: 'token', token };
            await API.addCredential(activeChannel, payload);
          }
        }
        showToast('凭据已保存', 'success');
        await loadConfigs();
      } catch (error) {
        showToast(error.message, 'danger');
      }
    });

    root.querySelectorAll('[data-action="remove"]').forEach(button => {
      button.addEventListener('click', async () => {
        if (!confirm('确定删除这个凭据？')) return;
        try {
          await API.removeCredential(activeChannel, button.dataset.id);
          showToast('凭据已删除', 'success');
          await loadConfigs();
        } catch (error) {
          showToast(error.message, 'danger');
        }
      });
    });

    root.querySelector('[data-action="test"]')?.addEventListener('click', async function () {
      const btn = this;
      btn.disabled = true;
      btn.textContent = '测试中...';
      try {
        const result = await API.testChannel(activeChannel);
        const removed = result.removed || false;
        if (!result.results || result.results.length <= 1) {
          showToast(result.results?.[0]?.message || result.message || '渠道测试完成', result.success ? 'success' : 'warning');
          if (removed) showToast('失效凭据已自动删除', 'warning');
        } else {
          const allOk = result.results.filter(r => r.success).length;
          const allCount = result.results.length;
          const detailRows = result.results.map(r => `<tr><td><code>${escapeHtml(r.label)}</code></td><td><span class="badge ${r.success ? 'badge-success' : 'badge-danger'}">${r.success ? '通过' : '失败'}</span></td><td>${escapeHtml(r.message)}</td></tr>`).join('');
          const modal = document.createElement('div');
          modal.className = 'test-modal';
          modal.innerHTML = `
            <div class="test-modal-overlay"></div>
            <div class="test-modal-card">
              <div class="panel-header"><h2>${escapeHtml(channelMeta[activeChannel]?.name || activeChannel)} 测试结果</h2><span>${allOk}/${allCount} 通过</span></div>
              <div class="table-wrap"><table class="table"><thead><tr><th>凭据</th><th>结果</th><th>消息</th></tr></thead><tbody>${detailRows}</tbody></table></div>
              <div class="toolbar" style="justify-content:flex-end"><button class="btn btn-secondary" type="button" data-test-modal-close>关闭</button></div>
            </div>
          `;
          document.body.appendChild(modal);
          modal.querySelector('[data-test-modal-close]')?.addEventListener('click', () => { modal.remove(); loadConfigs(); });
          modal.querySelector('.test-modal-overlay')?.addEventListener('click', () => { modal.remove(); loadConfigs(); });
        }
        if (removed) await loadConfigs();
      } catch (error) {
        showToast(error.message, 'danger');
      } finally {
        btn.disabled = false;
        btn.textContent = '测试渠道';
      }
    });
  }

  await loadConfigs();
  return () => {};
}
