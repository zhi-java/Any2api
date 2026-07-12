const invoke = async (cmd, args = {}) => {
  if (window.__TAURI__?.core?.invoke) {
    return window.__TAURI__.core.invoke(cmd, args);
  }
  return mockInvoke(cmd, args);
};

const listen = async (event, handler) => {
  if (window.__TAURI__?.event?.listen) {
    return window.__TAURI__.event.listen(event, (e) => handler(e.payload));
  }
  return () => {};
};

function mockInvoke(cmd, args = {}) {
  const base = {
    state: 'running',
    port: 3000,
    host: '127.0.0.1',
    endpoint: 'http://127.0.0.1:3000/v1',
    adminUrl: 'http://127.0.0.1:3000/admin',
    pid: 1,
    lastError: null,
    healthOk: true,
    message: '运行中',
  };
  if (cmd === 'get_shell_info') {
    return {
      version: '0.1.0-preview',
      repoRoot: '.',
      onboardingCompleted: false,
      launchAtLoginEnabled: false,
      config: {
        port: 3000,
        host: '127.0.0.1',
        onboardingCompleted: false,
        launchAtLogin: false,
        closeToTray: true,
        autoStartCore: true,
        adminApiKey: '',
      },
      core: base,
    };
  }
  if (cmd === 'get_core_status') return base;
  if (cmd === 'copy_endpoint') return base.endpoint;
  if (cmd === 'get_launch_at_login') return false;
  if (cmd === 'complete_onboarding' || cmd === 'set_admin_api_key' || cmd === 'get_config' || cmd === 'set_launch_at_login' || cmd === 'update_config') {
    return {
      port: 3000,
      host: '127.0.0.1',
      onboardingCompleted: cmd === 'complete_onboarding',
      launchAtLogin: cmd === 'set_launch_at_login' ? Boolean(args.enabled) : false,
      closeToTray: true,
      autoStartCore: true,
      adminApiKey: args.apiKey || args.api_key || '',
    };
  }
  if (cmd === 'admin_login' || cmd === 'admin_auth_status') {
    return { success: true, authenticated: true, authRequired: false };
  }
  if (cmd === 'add_channel_credential') {
    return { success: true, channel: args.channel };
  }
  if (cmd === 'test_channel') {
    return {
      success: true,
      channel: args.channel,
      results: [{ label: 'mock', success: true, message: '预览模式：未真实测通' }],
    };
  }
  if (cmd === 'get_admin_health') {
    return { status: 'healthy' };
  }
  return null;
}

const CHANNELS = [
  {
    id: 'deepseek',
    name: 'DeepSeek',
    hint: 'Local Storage: userToken',
    modes: ['token', 'account'],
    tokenLabel: 'userToken',
    tokenHint: '来源：Local Storage → userToken',
    accountHint: '账号模式使用上游网页登录账号/密码。如遇验证码或风控，优先使用 Token 模式。',
  },
  {
    id: 'qwen',
    name: 'Qwen',
    hint: 'Qwen Studio Cookie: token',
    modes: ['token', 'account'],
    tokenLabel: 'token',
    tokenHint: '来源：Qwen Studio Cookies → token',
    accountHint: '账号模式使用上游网页登录账号/密码。如遇验证码或风控，优先使用 Cookie 中的 token。',
  },
  {
    id: 'kimi',
    name: 'Kimi',
    hint: 'LocalStorage: access_token',
    modes: ['token'],
    tokenLabel: 'access_token',
    tokenHint: '来源：Local Storage → access_token',
  },
  {
    id: 'glm',
    name: 'GLM',
    hint: 'Cookie: chatglm_refresh_token',
    modes: ['token'],
    tokenLabel: 'chatglm_refresh_token',
    tokenHint: '来源：智谱清言 Cookies → chatglm_refresh_token',
  },
];

const state = {
  info: null,
  core: null,
  wizardStep: 0,
  selectedChannels: ['deepseek'],
  credChannel: 'deepseek',
  credType: 'token',
  token: '',
  email: '',
  password: '',
  adminKey: '',
  testResult: '',
  credentialSaved: false,
  launchAtLogin: false,
  copyInFlight: false,
  busy: false,
  error: '',
  note: '',
};

function esc(s) {
  return String(s ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

function statusClass(coreState) {
  if (coreState === 'running') return 'is-ok';
  if (coreState === 'degraded' || coreState === 'starting') return 'is-warn';
  if (coreState === 'crashed' || coreState === 'stopped') return 'is-bad';
  return 'is-muted';
}

function statusWord(coreState, message) {
  if (message) return message;
  const map = {
    running: '运行中',
    degraded: '需关注',
    starting: '启动中',
    stopped: '已停止',
    crashed: '已崩溃',
  };
  return map[coreState] || '检查中';
}

async function copyText(text) {
  if (!text) throw new Error('没有可复制内容');
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
    return;
  }
  const ta = document.createElement('textarea');
  ta.value = text;
  document.body.appendChild(ta);
  ta.select();
  document.execCommand('copy');
  ta.remove();
}

function el(html) {
  const t = document.createElement('template');
  t.innerHTML = html.trim();
  return t.content.firstElementChild;
}

function channelMeta(id) {
  return CHANNELS.find((c) => c.id === id) || CHANNELS[0];
}

function tokenFieldLabel(channel, meta) {
  if (channel === 'glm') return 'Refresh Token';
  if (meta?.tokenLabel) return `Token（${meta.tokenLabel}）`;
  return 'Token';
}

function captureWizardForm(root) {
  const token = root.querySelector('[name="token"]');
  const email = root.querySelector('[name="email"]');
  const password = root.querySelector('[name="password"]');
  const adminKey = root.querySelector('[name="adminKey"]');
  const typeSel = root.querySelector('[name="credType"]');
  const channelSel = root.querySelector('[name="credChannel"]');
  if (token) state.token = token.value;
  if (email) state.email = email.value;
  if (password) state.password = password.value;
  if (adminKey) state.adminKey = adminKey.value;
  if (typeSel) state.credType = typeSel.value;
  if (channelSel) state.credChannel = channelSel.value;
}

function render() {
  const root = document.getElementById('app');
  if (!state.info) {
    root.innerHTML = '<div class="boot">正在启动本地网关…</div>';
    return;
  }
  const onboardingDone = state.info.config?.onboardingCompleted || state.info.onboardingCompleted;
  if (!onboardingDone) {
    root.innerHTML = '';
    root.appendChild(renderWizard());
    bindWizard();
    return;
  }
  root.innerHTML = '';
  root.appendChild(renderHome());
  bindHome();
}

function renderWizard() {
  const step = state.wizardStep;
  const progress = [0, 1, 2, 3, 4].map((i) => '<i class="' + (i <= step ? 'on' : '') + '"></i>').join('');
  const core = state.core || state.info.core;
  const meta = channelMeta(state.credChannel);
  const supportsAccount = meta.modes.includes('account');

  let body = '';
  if (step === 0) {
    body = `
      <div class="wizard-kicker">首次设置</div>
      <h1>把网页模型变成本地 API</h1>
      <p>选择渠道 → 添加凭据并测通 → 复制地址给任意 OpenAI 兼容客户端。</p>
      <div class="protocol-chips" style="margin-bottom:14px">
        <span class="proto-chip">OpenAI <code>/v1/chat/completions</code></span>
        <span class="proto-chip">Anthropic <code>/v1/messages</code></span>
        <span class="proto-chip">Responses <code>/v1/responses</code></span>
      </div>
      <div class="chip-row">
        <span class="chip info">关窗不停服</span>
        <span class="chip ok">托盘常驻</span>
        <span class="chip">OpenAI 兼容</span>
      </div>
    `;
  } else if (step === 1) {
    body = `
      <div class="wizard-kicker">步骤 1 / 4</div>
      <h1>选择要启用的渠道</h1>
      <p>先勾选你常用的上游；下一步只为其中一个填写凭据，其余可稍后在控制台添加。</p>
      <div class="channel-pick">
        ${CHANNELS.map((c) => `
          <button type="button" class="pick ${state.selectedChannels.includes(c.id) ? 'active' : ''}" data-channel="${c.id}">
            <strong>${c.name}</strong>
            <span>${c.hint}</span>
          </button>
        `).join('')}
      </div>
    `;
  } else if (step === 2) {
    body = `
      <div class="wizard-kicker">步骤 2 / 4</div>
      <h1>添加第一条凭据</h1>
      <p>通过桌面壳调用本机 Admin API。若后台启用了 API_KEY，请填写管理密钥。</p>
      <div class="field">
        <label>管理 API Key（可选）</label>
        <input name="adminKey" type="password" autocomplete="off" placeholder="与 .env 中 API_KEY 一致" value="${esc(state.adminKey)}" />
      </div>
      <div class="field">
        <label>渠道</label>
        <select name="credChannel">
          ${state.selectedChannels.map((id) => {
            const c = channelMeta(id);
            return '<option value="' + c.id + '"' + (state.credChannel === c.id ? ' selected' : '') + '>' + c.name + '</option>';
          }).join('')}
        </select>
      </div>
      ${supportsAccount ? `
        <div class="field">
          <label>类型</label>
          <select name="credType">
            <option value="token" ${state.credType === 'token' ? 'selected' : ''}>Token</option>
            <option value="account" ${state.credType === 'account' ? 'selected' : ''}>账号密码</option>
          </select>
        </div>
      ` : '<input type="hidden" name="credType" value="token" />'}
      <div data-token-fields ${state.credType === 'account' ? 'hidden' : ''}>
        <div class="field">
          <label>${esc(tokenFieldLabel(state.credChannel, meta))}</label>
          <input name="token" type="password" autocomplete="off" placeholder="粘贴 Token" value="${esc(state.token)}" />
          <small>${esc(meta.tokenHint)}</small>
        </div>
      </div>
      <div data-account-fields ${state.credType === 'account' ? '' : 'hidden'}>
        <div class="field">
          <label>邮箱</label>
          <input name="email" type="email" autocomplete="off" value="${esc(state.email)}" />
        </div>
        <div class="field">
          <label>密码</label>
          <input name="password" type="password" autocomplete="off" value="${esc(state.password)}" />
        </div>
        <small style="color:var(--text-secondary);font-size:12px;display:block;margin-top:-8px;margin-bottom:8px">${esc(meta.accountHint || '')}</small>
      </div>
      <div class="actions-row">
        <button type="button" class="btn btn-primary btn-sm" data-action="save-cred" ${state.busy ? 'disabled' : ''}>保存凭据</button>
        <button type="button" class="btn btn-secondary btn-sm" data-action="test-cred" ${state.busy ? 'disabled' : ''}>测试渠道</button>
        <button type="button" class="btn btn-ghost btn-sm" data-action="skip-cred">稍后再配</button>
      </div>
      ${state.credentialSaved ? '<div class="success-banner" style="margin-top:12px">凭据已保存' + (state.testResult ? ' · ' + esc(state.testResult) : '') + '</div>' : ''}
      ${!state.credentialSaved && state.testResult ? '<div class="hint">' + esc(state.testResult) + '</div>' : ''}
    `;
  } else if (step === 3) {
    body = `
      <div class="wizard-kicker">步骤 3 / 4</div>
      <h1>确认服务可用</h1>
      <p>桌面壳会轮询本机 <code>/healthz</code>。看到「运行中」即可接入客户端。</p>
      <div class="status-row" style="margin-top:12px">
        <div>
          <div class="label">服务状态</div>
          <div class="status-word ${statusClass(core?.state)}">${statusWord(core?.state, core?.message)}</div>
        </div>
      </div>
      <div class="endpoint-well"><code>${esc(core?.endpoint || '')}</code></div>
      ${core?.lastError ? '<div class="error">' + esc(core.lastError) + '</div>' : ''}
    `;
  } else {
    body = `
      <div class="wizard-kicker">完成</div>
      <h1>可以粘贴 Base URL 到客户端了</h1>
      <p>把下面的地址填到任意 OpenAI 兼容客户端。API Key 使用你在 Admin / 设置中的访问密钥。</p>
      <div class="endpoint-well"><code id="wizard-endpoint">${esc(core?.endpoint || '')}</code></div>
      <div class="protocol-chips" style="margin-bottom:14px">
        <span class="proto-chip">OpenAI <code>/v1/chat/completions</code></span>
        <span class="proto-chip">Anthropic <code>/v1/messages</code></span>
        <span class="proto-chip">Responses <code>/v1/responses</code></span>
      </div>
      <div class="actions-row">
        <button type="button" class="btn btn-primary" data-action="copy">复制 API 地址</button>
        <button type="button" class="btn btn-secondary" data-action="open-admin">打开控制台</button>
      </div>
    `;
  }

  const footerLeft = step === 0
    ? '<button type="button" class="btn btn-ghost" data-action="skip">我已有配置，直接进入</button>'
    : '<button type="button" class="btn btn-ghost" data-action="back">上一步</button>';

  const footerRight = step < 4
    ? '<button type="button" class="btn btn-primary" data-action="next" ' + (state.busy ? 'disabled' : '') + '>' + (step === 0 ? '开始设置' : '继续') + '</button>'
    : '<button type="button" class="btn btn-primary" data-action="finish" ' + (state.busy ? 'disabled' : '') + '>进入首页</button>';

  return el(`
    <div class="wizard">
      <div class="wizard-card">
        <div class="wizard-progress">${progress}</div>
        ${body}
        ${state.error ? '<div class="error">' + esc(state.error) + '</div>' : ''}
        ${state.note ? '<div class="hint">' + esc(state.note) + '</div>' : ''}
        <div class="wizard-footer">
          <div>${footerLeft}</div>
          <div style="display:flex;gap:8px;flex-wrap:wrap">${footerRight}</div>
        </div>
      </div>
    </div>
  `);
}

function bindWizard() {
  const root = document.getElementById('app');

  root.querySelectorAll('[data-channel]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const id = btn.getAttribute('data-channel');
      if (state.selectedChannels.includes(id)) {
        state.selectedChannels = state.selectedChannels.filter((x) => x !== id);
      } else {
        state.selectedChannels = [...state.selectedChannels, id];
      }
      if (!state.selectedChannels.length) state.selectedChannels = [id];
      if (!state.selectedChannels.includes(state.credChannel)) {
        state.credChannel = state.selectedChannels[0];
      }
      render();
    });
  });

  root.querySelector('[name="credChannel"]')?.addEventListener('change', (e) => {
    state.credChannel = e.target.value;
    const meta = channelMeta(state.credChannel);
    if (!meta.modes.includes(state.credType)) state.credType = 'token';
    captureWizardForm(root);
    render();
  });

  root.querySelector('[name="credType"]')?.addEventListener('change', (e) => {
    state.credType = e.target.value;
    captureWizardForm(root);
    render();
  });

  root.querySelector('[data-action="skip"]')?.addEventListener('click', async () => {
    await finishOnboarding();
  });
  root.querySelector('[data-action="back"]')?.addEventListener('click', () => {
    captureWizardForm(root);
    state.wizardStep = Math.max(0, state.wizardStep - 1);
    state.error = '';
    render();
  });
  root.querySelector('[data-action="next"]')?.addEventListener('click', async () => {
    captureWizardForm(root);
    state.error = '';
    if (state.wizardStep === 1 && !state.selectedChannels.length) {
      state.error = '请至少选择一个渠道';
      render();
      return;
    }
    if (state.wizardStep === 0) {
      try {
        state.busy = true;
        render();
        state.core = await invoke('get_core_status');
      } catch (e) {
        state.error = e?.message || String(e);
      } finally {
        state.busy = false;
      }
    }
    if (state.wizardStep === 1) {
      if (!state.selectedChannels.includes(state.credChannel)) {
        state.credChannel = state.selectedChannels[0];
      }
    }
    state.wizardStep += 1;
    render();
  });
  root.querySelector('[data-action="finish"]')?.addEventListener('click', async () => {
    await finishOnboarding();
  });
  root.querySelector('[data-action="copy"]')?.addEventListener('click', async () => {
    await doCopyEndpoint();
  });
  root.querySelector('[data-action="open-admin"]')?.addEventListener('click', async () => {
    try {
      await invoke('open_admin');
    } catch (e) {
      const url = state.core?.adminUrl || state.info?.core?.adminUrl;
      if (url) window.open(url, '_blank');
      else {
        state.error = e?.message || String(e);
        render();
      }
    }
  });
  root.querySelector('[data-action="skip-cred"]')?.addEventListener('click', () => {
    captureWizardForm(root);
    state.wizardStep = 3;
    state.note = '已跳过凭据，可稍后在控制台配置';
    state.error = '';
    render();
  });
  root.querySelector('[data-action="save-cred"]')?.addEventListener('click', async () => {
    captureWizardForm(root);
    await saveCredential();
  });
  root.querySelector('[data-action="test-cred"]')?.addEventListener('click', async () => {
    captureWizardForm(root);
    await testCredential();
  });
}

function buildCredentialPayload() {
  if (state.credType === 'account') {
    if (!state.email || !state.password) throw new Error('请填写邮箱和密码');
    return { type: 'account', email: state.email, password: state.password };
  }
  const token = String(state.token || '').trim();
  if (!token) throw new Error('请粘贴 Token');
  if (state.credChannel === 'glm') {
    return { type: 'token', refreshToken: token };
  }
  return { type: 'token', token };
}

async function ensureAdminKey() {
  if (state.adminKey.trim()) {
    await invoke('set_admin_api_key', { apiKey: state.adminKey.trim() });
  }
}

async function saveCredential() {
  try {
    state.busy = true;
    state.error = '';
    state.note = '';
    render();
    await ensureAdminKey();
    const payload = buildCredentialPayload();
    await invoke('add_channel_credential', {
      channel: state.credChannel,
      payload,
    });
    state.credentialSaved = true;
    state.note = `${channelMeta(state.credChannel).name} 凭据已保存`;
    state.token = '';
    state.password = '';
  } catch (e) {
    state.error = e?.message || String(e);
  } finally {
    state.busy = false;
    render();
  }
}

async function testCredential() {
  try {
    state.busy = true;
    state.error = '';
    render();
    await ensureAdminKey();
    const hasInput = state.credType === 'account'
      ? (state.email && state.password)
      : Boolean(String(state.token || '').trim());
    if (hasInput && !state.credentialSaved) {
      const payload = buildCredentialPayload();
      await invoke('add_channel_credential', {
        channel: state.credChannel,
        payload,
      });
      state.credentialSaved = true;
    }
    const result = await invoke('test_channel', { channel: state.credChannel });
    const ok = Boolean(result?.success);
    const first = result?.results?.[0];
    const detail = first?.message || result?.message || (ok ? '测通成功' : '测通失败');
    state.testResult = `${ok ? '通过' : '失败'} · ${detail}`;
    if (!ok) state.error = state.testResult;
    else state.note = state.testResult;
  } catch (e) {
    state.error = e?.message || String(e);
  } finally {
    state.busy = false;
    render();
  }
}

async function finishOnboarding() {
  try {
    state.busy = true;
    render();
    const cfg = await invoke('complete_onboarding');
    state.info.config = cfg;
    state.info.onboardingCompleted = true;
    state.wizardStep = 0;
    state.note = '';
    state.error = '';
  } catch (e) {
    state.error = e?.message || String(e);
  } finally {
    state.busy = false;
    render();
  }
}

async function doCopyEndpoint() {
  if (state.copyInFlight) return;
  state.copyInFlight = true;
  try {
    const endpoint = await invoke('copy_endpoint');
    await copyText(endpoint);
    state.note = '已复制 API 地址';
  } catch (e) {
    state.error = e?.message || String(e);
  } finally {
    state.copyInFlight = false;
    render();
  }
}

function renderHome() {
  const core = state.core || state.info.core;
  const launch = state.launchAtLogin;
  return el(`
    <div class="shell">
      <header class="topbar">
        <div class="brand">
          <div class="brand-mark">O</div>
          <div>
            <strong>OmniAPI</strong>
            <span>本地 AI 网关 · v${esc(state.info.version || '0.1.0')}</span>
          </div>
        </div>
        <div class="top-actions">
          <button type="button" class="btn btn-secondary btn-sm" data-action="open-admin">打开控制台</button>
        </div>
      </header>
      <main class="content">
        <div class="hero-grid">
          <section class="card">
            <div class="status-row">
              <div>
                <div class="label">服务状态</div>
                <div class="status-word ${statusClass(core?.state)}">${statusWord(core?.state, core?.message)}</div>
              </div>
              <span class="chip ${core?.healthOk ? 'ok' : 'warn'}">自动托管</span>
            </div>
            <div class="endpoint-well">
              <code>${esc(core?.endpoint || '')}</code>
              <button type="button" class="btn btn-primary btn-sm" data-action="copy">复制 API 地址</button>
            </div>
            <div class="protocol-chips">
              <span class="proto-chip">OpenAI <code>/v1/chat/completions</code></span>
              <span class="proto-chip">Anthropic <code>/v1/messages</code></span>
              <span class="proto-chip">Responses <code>/v1/responses</code></span>
            </div>
            <div class="chip-row">
              <span class="chip info">${esc(core?.host || '127.0.0.1')}:${esc(core?.port || 3000)}</span>
              <span class="chip ${core?.healthOk ? 'ok' : 'warn'}">${core?.healthOk ? 'healthz OK' : '等待就绪'}</span>
              ${core?.pid ? '<span class="chip">PID ' + esc(core.pid) + '</span>' : ''}
              <span class="chip ${launch ? 'ok' : ''}">开机自启 ${launch ? '开' : '关'}</span>
            </div>
            ${core?.lastError ? '<div class="error" style="margin-top:12px">' + esc(core.lastError) + '</div>' : ''}
            ${state.note ? '<div class="hint">' + esc(state.note) + '</div>' : ''}
          </section>
          <section class="card">
            <h2>偏好</h2>
            <p>关窗进托盘、开机自启与网关生命周期由桌面壳管理。</p>
            <label class="pref-row">
              <div>
                <strong>开机自启</strong>
                <small>登录 Windows 后自动启动 OmniAPI（进托盘）</small>
              </div>
              <button type="button" class="toggle ${launch ? '' : 'is-off'}" data-action="toggle-autostart" title="开机自启" aria-checked="${launch}"></button>
            </label>
            <div class="step-list" style="margin-top:14px">
              <div class="step-item is-done"><span class="n">✓</span><div><strong>启动本机网关</strong><small>由桌面壳管理进程</small></div></div>
              <div class="step-item is-current"><span class="n">2</span><div><strong>管理凭据与测通</strong><small>DeepSeek / Qwen / Kimi / GLM</small></div></div>
              <div class="step-item"><span class="n">3</span><div><strong>复制地址到客户端</strong></div></div>
            </div>
            <div class="actions-row">
              <button type="button" class="btn btn-secondary btn-sm" data-action="open-admin">打开控制台</button>
              <button type="button" class="btn btn-ghost btn-sm" data-action="copy">复制 Endpoint</button>
            </div>
          </section>
        </div>
        <div class="metric-grid">
          <article class="metric"><span>模式</span><strong>桌面</strong><small>Tauri 托盘壳</small></article>
          <article class="metric"><span>Core</span><strong>${esc(core?.state || '-')}</strong><small>自动重启已开启</small></article>
          <article class="metric"><span>Endpoint</span><strong style="font-size:16px">/v1</strong><small>${esc(core?.host || '127.0.0.1')}</small></article>
          <article class="metric"><span>关窗行为</span><strong style="font-size:18px">托盘</strong><small>不停服</small></article>
        </div>
      </main>
    </div>
  `);
}

function bindHome() {
  const root = document.getElementById('app');
  root.querySelectorAll('[data-action="copy"]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      await doCopyEndpoint();
    });
  });
  root.querySelectorAll('[data-action="open-admin"]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      try {
        await invoke('open_admin');
      } catch {
        const url = state.core?.adminUrl || state.info?.core?.adminUrl;
        if (url) window.open(url, '_blank');
      }
    });
  });
  root.querySelector('[data-action="toggle-autostart"]')?.addEventListener('click', async () => {
    try {
      const next = !state.launchAtLogin;
      const cfg = await invoke('set_launch_at_login', { enabled: next });
      state.launchAtLogin = Boolean(cfg?.launchAtLogin ?? next);
      if (state.info?.config) state.info.config.launchAtLogin = state.launchAtLogin;
      state.note = state.launchAtLogin ? '已开启开机自启' : '已关闭开机自启';
      render();
    } catch (e) {
      state.note = e?.message || String(e);
      render();
    }
  });
}

function coreStatusSig(c) {
  if (!c) return '';
  return [c.state, c.message, c.pid, c.healthOk, c.lastError, c.endpoint].join('|');
}

let lastCoreSig = '';

async function bootstrap() {
  try {
    state.info = await invoke('get_shell_info');
    state.core = state.info.core;
    lastCoreSig = coreStatusSig(state.core);
    state.adminKey = state.info.config?.adminApiKey || '';
    state.launchAtLogin = Boolean(
      state.info.launchAtLoginEnabled ?? state.info.config?.launchAtLogin
    );
    render();
    await listen('core-status', (payload) => {
      const sig = coreStatusSig(payload);
      state.core = payload;
      // 后端每 3 秒推送一次；状态没变就不重建 DOM，避免打断输入和焦点。
      if (sig === lastCoreSig) return;
      lastCoreSig = sig;
      if (state.info?.config?.onboardingCompleted || state.info?.onboardingCompleted) {
        render();
      } else if (state.wizardStep !== 2) {
        render();
      } else {
        const word = document.querySelector('.status-word');
        if (word) {
          word.textContent = statusWord(payload?.state, payload?.message);
          word.className = `status-word ${statusClass(payload?.state)}`;
        }
      }
    });
    state.core = await invoke('get_core_status');
    lastCoreSig = coreStatusSig(state.core);
    render();
  } catch (e) {
    document.getElementById('app').innerHTML = '<div class="boot">启动失败：' + esc(e?.message || e) + '</div>';
  }
}

bootstrap();
