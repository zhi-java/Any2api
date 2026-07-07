import API from './api.js';
import { showToast } from './ui.js';
import { renderDashboard } from './views/dashboard.js';
import { renderChannels } from './views/channels.js';
import { renderCredentials } from './views/credentials.js';
import { renderApiKeys } from './views/api-keys.js';
import { renderSettings } from './views/settings.js';
import { renderLogs } from './views/logs.js';
import { renderPerformance } from './views/performance.js';
import { initChartDefaults } from './charts.js';

initChartDefaults();

const routes = {
  dashboard: { label: 'Dashboard', eyebrow: 'Overview', render: renderDashboard },
  channels: { label: '渠道', eyebrow: 'Routing', render: renderChannels },
  credentials: { label: '上游凭据', eyebrow: 'Secrets', render: renderCredentials },
  apiKeys: { label: 'API Keys', eyebrow: 'Access', render: renderApiKeys },
  settings: { label: '配置', eyebrow: 'Runtime', render: renderSettings },
  logs: { label: '日志', eyebrow: 'Observability', render: renderLogs },
  performance: { label: '性能', eyebrow: 'Telemetry', render: renderPerformance },
};

let currentCleanup = null;

function setAuthenticated(authenticated) {
  document.getElementById('loginView').hidden = authenticated;
  document.getElementById('appShell').hidden = !authenticated;
}

function currentRoute() {
  const name = location.hash.replace(/^#/, '') || 'dashboard';
  return routes[name] ? name : 'dashboard';
}

function renderNav() {
  const nav = document.getElementById('nav');
  nav.innerHTML = Object.entries(routes).map(([key, route]) => (
    `<a class="nav-item" href="#${key}" data-route="${key}"><span>${route.label}</span></a>`
  )).join('');
}

async function renderRoute() {
  if (currentCleanup) currentCleanup();
  currentCleanup = null;

  const key = currentRoute();
  const route = routes[key];
  document.querySelectorAll('.nav-item').forEach(item => item.classList.toggle('active', item.dataset.route === key));
  document.getElementById('sectionEyebrow').textContent = route.eyebrow;
  document.getElementById('sectionTitle').textContent = route.label;

  const root = document.getElementById('viewRoot');
  root.innerHTML = '<div class="page-loading">加载中...</div>';
  currentCleanup = await route.render(root, { API });
}

async function confirmSession() {
  const status = await API.getAuthStatus();
  if (!status.authRequired || status.authenticated) {
    setAuthenticated(true);
    await renderRoute();
    return;
  }
  setAuthenticated(false);
}

document.getElementById('logoutBtn').addEventListener('click', async () => {
  try {
    await API.logout();
  } finally {
    localStorage.removeItem('admin_api_key');
    if (currentCleanup) currentCleanup();
    currentCleanup = null;
    setAuthenticated(false);
    showToast('已退出');
  }
});

window.addEventListener('hashchange', () => {
  renderRoute().catch(error => {
    console.error(error);
    showToast(error.message, 'danger');
  });
});

window.addEventListener('auth:expired', () => {
  if (currentCleanup) currentCleanup();
  currentCleanup = null;
  setAuthenticated(false);
});

window.addEventListener('admin:authenticated', () => {
  renderRoute().catch(error => {
    console.error(error);
    showToast(error.message, 'danger');
  });
});

renderNav();
confirmSession().catch(error => {
  console.error(error);
  setAuthenticated(false);
});
