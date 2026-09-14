import { escapeHtml, showToast } from '../ui.js';

let activeSettingsTab = 'service';

const SETTINGS_TABS = [
  { id: 'service', label: '服务' },
  { id: 'logs', label: '日志' },
  { id: 'session', label: '会话' },
  { id: 'generation', label: '生成' },
  { id: 'startup', label: '启动变量' },
];

function checked(value) {
  return value ? 'checked' : '';
}

function numberField(name, label, value, min = 0) {
  return `<label class="field-label">${escapeHtml(label)}</label><input class="input" name="${name}" type="number" min="${min}" value="${escapeHtml(value)}">`;
}

function textField(name, label, value, placeholder = '') {
  return `<label class="field-label">${escapeHtml(label)}</label><input class="input" name="${name}" autocomplete="off" value="${escapeHtml(value || '')}" placeholder="${escapeHtml(placeholder)}">`;
}

function switchField(name, label, value) {
  return `<label class="switch-row"><input type="checkbox" name="${name}" ${checked(value)}> ${escapeHtml(label)}</label>`;
}

function render(root, config) {
  const server = config.server || {};
  const runtime = config.runtime || {};
  const deepseek = config.deepseek || {};

  root.innerHTML = `
    <div class="compact-page settings-workbench">
      <div class="settings-tabs">
        ${SETTINGS_TABS.map(tab => `<button type="button" class="tab ${tab.id === activeSettingsTab ? 'active' : ''}" data-settings-tab="${tab.id}">${tab.label}</button>`).join('')}
      </div>
      <form id="settingsForm" class="content-grid" style="gap:10px">
        <div class="settings-tab-panel" data-tab="service" ${activeSettingsTab === 'service' ? '' : 'hidden'}>
          <section class="panel compact-panel settings-panel">
            <div class="panel-header"><h2>服务行为</h2><span>server</span></div>
            <div class="form-stack">
              ${switchField('mergeThinking', '合并 thinking 到 content', server.mergeThinking)}
              ${switchField('enablePromptInjection', '启用工具提示词注入', server.enablePromptInjection)}
              ${textField('systemFingerprint', 'OpenAI system_fingerprint', server.systemFingerprint, 'fp_omni_v1')}
            </div>
          </section>
          <div class="toolbar settings-save-row"><button class="btn btn-primary" type="submit">保存运行配置</button></div>
        </div>

        <div class="settings-tab-panel" data-tab="logs" ${activeSettingsTab === 'logs' ? '' : 'hidden'}>
          <section class="panel compact-panel settings-panel">
            <div class="panel-header"><h2>日志</h2><span>logs</span></div>
            <div class="form-stack">
              ${textField('logDir', '日志目录', runtime.logDir, '留空使用数据目录/logs')}
              ${switchField('clientDebugLog', '启用客户端调试日志', server.clientDebugLog)}
              ${textField('clientDebugLogDir', '客户端调试日志目录', server.clientDebugLogDir, '留空跟随日志目录')}
              ${numberField('clientDebugLogMaxChars', '单字段最大记录字符数', server.clientDebugLogMaxChars, 1000)}
            </div>
          </section>
          <div class="toolbar settings-save-row"><button class="btn btn-primary" type="submit">保存运行配置</button></div>
        </div>

        <div class="settings-tab-panel" data-tab="session" ${activeSettingsTab === 'session' ? '' : 'hidden'}>
          <section class="panel compact-panel settings-panel">
            <div class="panel-header"><h2>会话与多轮</h2><span>runtime</span></div>
            <div class="form-stack">
              ${numberField('sessionTtlSeconds', 'DeepSeek 会话 TTL（秒）', runtime.sessionTtlSeconds, 1)}
              ${switchField('enableConversationAffinity', '启用对话亲和', runtime.enableConversationAffinity)}
              ${numberField('conversationTtlMs', '对话空闲回收时间（毫秒）', runtime.conversationTtlMs, 1000)}
              ${numberField('maxConversations', '最大对话数', runtime.maxConversations, 1)}
            </div>
          </section>
          <div class="toolbar settings-save-row"><button class="btn btn-primary" type="submit">保存运行配置</button></div>
        </div>

        <div class="settings-tab-panel" data-tab="generation" ${activeSettingsTab === 'generation' ? '' : 'hidden'}>
          <section class="panel compact-panel settings-panel">
            <div class="panel-header"><h2>工具与上下文</h2><span>generation</span></div>
            <div class="form-stack">
              ${switchField('enableFcErrorRetry', '工具调用格式错误自动重试', runtime.enableFcErrorRetry)}
            </div>
          </section>
          <div class="toolbar settings-save-row"><button class="btn btn-primary" type="submit">保存运行配置</button></div>
        </div>

        <div class="settings-tab-panel" data-tab="startup" ${activeSettingsTab === 'startup' ? '' : 'hidden'}>
          <section class="panel compact-panel settings-panel">
            <div class="panel-header"><h2>启动层变量</h2><span>只读</span></div>
            <div class="table-wrap">
              <table class="table dense-table"><thead><tr><th>变量</th><th>说明</th></tr></thead><tbody>
                <tr><td><code>PORT</code></td><td>监听端口，启动后无法由页面热切换</td></tr>
                <tr><td><code>ZHI2API_ENV_PATH</code></td><td>环境文件路径，必须在读取环境前决定</td></tr>
                <tr><td><code>ZHI2API_CONFIG_PATH</code></td><td>配置文件路径，必须在配置加载前决定</td></tr>
                <tr><td><code>ZHI2API_DATA_DIR</code></td><td>数据目录，影响配置与日志默认路径</td></tr>
                <tr><td><code>HTTP_PROXY / HTTPS_PROXY</code></td><td>出站代理，涉及底层 dispatcher 初始化，建议部署层配置后重启</td></tr>
              </tbody></table>
            </div>
          </section>
        </div>
      </form>
    </div>
  `;
}

function numeric(data, name) {
  return Number.parseInt(data.get(name), 10);
}

export async function renderSettings(root, { API }) {
  root.innerHTML = '<div class="page-loading">加载运行配置...</div>';
  let config = {};

  async function loadConfig() {
    const result = await API.getConfig();
    config = result.config || {};
    render(root, config);
    bindEvents();
  }

  function bindEvents() {
    root.querySelectorAll('[data-settings-tab]').forEach(button => {
      button.addEventListener('click', () => {
        const tabId = button.dataset.settingsTab;
        activeSettingsTab = tabId;
        root.querySelectorAll('[data-settings-tab]').forEach(b => b.classList.toggle('active', b.dataset.settingsTab === tabId));
        root.querySelectorAll('.settings-tab-panel').forEach(p => p.hidden = p.dataset.tab !== tabId);
      });
    });

    root.querySelector('#settingsForm')?.addEventListener('submit', async event => {
      event.preventDefault();
      const data = new FormData(event.currentTarget);
      const patch = {
        server: {
          mergeThinking: data.get('mergeThinking') === 'on',
          enablePromptInjection: data.get('enablePromptInjection') === 'on',
          systemFingerprint: data.get('systemFingerprint'),
          clientDebugLog: data.get('clientDebugLog') === 'on',
          clientDebugLogDir: data.get('clientDebugLogDir'),
          clientDebugLogMaxChars: numeric(data, 'clientDebugLogMaxChars'),
        },
        runtime: {
          logDir: data.get('logDir'),
          sessionTtlSeconds: numeric(data, 'sessionTtlSeconds'),
          enableConversationAffinity: data.get('enableConversationAffinity') === 'on',
          conversationTtlMs: numeric(data, 'conversationTtlMs'),
          maxConversations: numeric(data, 'maxConversations'),
          enableFcErrorRetry: data.get('enableFcErrorRetry') === 'on',
        },
      };
      try {
        const result = await API.updateConfig(patch);
        config = result.config || config;
        showToast('运行配置已保存', 'success');
        render(root, config);
        bindEvents();
      } catch (error) {
        showToast(error.message, 'danger');
      }
    });
  }

  await loadConfig();
  return () => {};
}
