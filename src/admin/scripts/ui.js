export function escapeHtml(value) {
  const div = document.createElement('div');
  div.textContent = value == null ? '' : String(value);
  return div.innerHTML;
}

export function formatNumber(value) {
  const number = Number(value || 0);
  if (number >= 1_000_000) return `${(number / 1_000_000).toFixed(1)}M`;
  if (number >= 1_000) return `${(number / 1_000).toFixed(1)}K`;
  return String(number);
}

export function formatDurationMs(value) {
  const number = Number(value || 0);
  if (number < 1000) return `${number}ms`;
  return `${(number / 1000).toFixed(1)}s`;
}

export function formatTime(value) {
  if (!value) return '-';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return date.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

export function statusBadge(status) {
  const map = {
    healthy: ['健康', 'success'],
    degraded: ['降级', 'warning'],
    unconfigured: ['未配置', 'muted'],
    unavailable: ['不可用', 'danger'],
    running: ['运行中', 'success'],
  };
  const [label, tone] = map[status] || [status || '未知', 'muted'];
  return `<span class="badge badge-${tone}">${escapeHtml(label)}</span>`;
}

export function capabilityBadge(label, enabled) {
  return `<span class="badge ${enabled ? 'badge-info' : 'badge-muted'}">${escapeHtml(label)}</span>`;
}

export function emptyState(title, detail = '') {
  return `<div class="empty-state"><strong>${escapeHtml(title)}</strong>${detail ? `<span>${escapeHtml(detail)}</span>` : ''}</div>`;
}

export function skeletonCards(count = 4) {
  return `<div class="metric-grid">${Array.from({ length: count }, () => '<article class="metric-card skeleton"></article>').join('')}</div>`;
}

export function showToast(message, tone = 'info') {
  const root = document.getElementById('toastRoot');
  if (!root) return;
  const item = document.createElement('div');
  item.className = `toast toast-${tone}`;
  item.textContent = message;
  root.appendChild(item);
  setTimeout(() => item.remove(), 3200);
}

export function debounce(fn, wait = 200) {
  let timer = null;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), wait);
  };
}
