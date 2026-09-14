import { useCallback, useEffect, useState } from 'react';
import { api } from '../lib/api';
import { useDebounced } from '../lib/hooks';
import { formatTime } from '../lib/format';
import { Card, EmptyState, Input, PanelHeader, Select } from '../components/ui';
import type { LogEntry } from '../types';

const LEVEL_TONE: Record<string, string> = {
  error: 'border-bad/30 bg-bad-soft',
  warn: 'border-warn/30 bg-warn-soft',
  success: 'border-line bg-surface',
};

export function LogsPage() {
  const [count, setCount] = useState('60');
  const [channel, setChannel] = useState('all');
  const [status, setStatus] = useState('all');
  const [search, setSearch] = useState('');
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [loaded, setLoaded] = useState(false);
  const debouncedSearch = useDebounced(search, 250);

  const load = useCallback(async () => {
    try {
      const result = await api.getLogs(count, {
        channel,
        status,
        search: debouncedSearch,
        model: 'all',
      });
      setLogs(result.logs ?? []);
    } finally {
      setLoaded(true);
    }
  }, [count, channel, status, debouncedSearch]);

  useEffect(() => {
    void load();
  }, [load]);

  // 轮询刷新，页面隐藏时跳过
  useEffect(() => {
    const timer = window.setInterval(() => {
      if (!document.hidden) void load();
    }, 10_000);
    const onVisible = () => {
      if (!document.hidden) void load();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [load]);

  return (
    <div className="grid gap-4">
      <Card className="py-3">
        <div className="flex flex-wrap gap-2.5">
          <Select value={count} onChange={e => setCount(e.target.value)} aria-label="日志条数">
            {['30', '60', '100', '200'].map(item => (
              <option key={item} value={item}>
                {item} 条
              </option>
            ))}
          </Select>
          <Select value={channel} onChange={e => setChannel(e.target.value)} aria-label="渠道筛选">
            <option value="all">全部渠道</option>
            <option value="deepseek">DeepSeek</option>
          </Select>
          <Select value={status} onChange={e => setStatus(e.target.value)} aria-label="状态筛选">
            <option value="all">全部状态</option>
            <option value="success">成功</option>
            <option value="error">错误</option>
          </Select>
          <Input
            type="search"
            placeholder="搜索日志"
            value={search}
            onChange={e => setSearch(e.target.value)}
            className="max-w-[280px]"
          />
        </div>
      </Card>

      <Card>
        <PanelHeader title="近期日志" hint={`${logs.length} 条`} />
        {logs.length ? (
          <div className="grid gap-1.5">
            {logs.map((log, index) => {
              const level = String(log.level || 'info').toLowerCase();
              return (
                <article
                  key={`${log.time}-${index}`}
                  className={`grid grid-cols-[92px_76px_1fr] items-start gap-3 rounded-xl border px-3 py-2 text-[13px] ${
                    LEVEL_TONE[level] ?? 'border-line bg-subtle'
                  }`}
                >
                  <time className="tabular font-mono text-[12px] text-ink-3">{formatTime(log.time)}</time>
                  <strong
                    className={`text-[12px] font-bold ${
                      level === 'error' ? 'text-bad' : level === 'warn' ? 'text-warn-ink' : 'text-ok'
                    }`}
                  >
                    {log.level || ''}
                  </strong>
                  <span className="break-all font-mono text-[12px] text-ink-2">{log.message || ''}</span>
                </article>
              );
            })}
          </div>
        ) : (
          <EmptyState title={loaded ? '暂无日志' : '加载中…'} />
        )}
      </Card>
    </div>
  );
}
