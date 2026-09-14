import type { ChannelStatus } from '../types';

export function formatNumber(value: number | undefined): string {
  const n = Number(value || 0);
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

export function formatDuration(value: number | undefined): string {
  const n = Number(value || 0);
  if (!n) return '-';
  if (n < 1000) return `${n}ms`;
  return `${(n / 1000).toFixed(1)}s`;
}

export function formatTime(value: string | undefined): string {
  if (!value) return '-';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return date.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

export function formatDateTime(value: string | undefined): string {
  if (!value) return '-';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '-';
  return date.toLocaleString('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}

const STATUS_LABEL: Record<ChannelStatus, string> = {
  healthy: '健康',
  degraded: '需关注',
  unconfigured: '未配置',
  unavailable: '不可用',
};

const STATUS_TONE: Record<ChannelStatus, 'ok' | 'warn' | 'muted' | 'bad'> = {
  healthy: 'ok',
  degraded: 'warn',
  unconfigured: 'muted',
  unavailable: 'bad',
};

export function statusLabel(status: ChannelStatus): string {
  return STATUS_LABEL[status] ?? String(status);
}

export function statusTone(status: ChannelStatus): 'ok' | 'warn' | 'muted' | 'bad' {
  return STATUS_TONE[status] ?? 'muted';
}

/** 复制到剪贴板，带旧浏览器回退。 */
export async function copyText(text: string): Promise<void> {
  if (!text) throw new Error('没有可复制的内容');
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
