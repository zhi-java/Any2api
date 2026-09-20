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
        {/* 窄屏时三个下拉各占整行、搜索框铺满，避免挤在一行导致溢出 */}
        <div className="grid gap-2.5 sm:grid-cols-[auto_auto_auto_minmax(0,1fr)]">
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
            className="sm:max-w-none"
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
                  // 窄屏改为「时间+级别」一行、消息另起一行；宽屏仍是三列。
                  // 原先固定 92px/76px 像素列在 375px 下会把消息挤到几乎不可读。
                  className={`grid items-start gap-x-3 gap-y-1 rounded-xl border px-3 py-2 text-[13px] sm:grid-cols-[92px_76px_1fr] grid-cols-[92px_1fr] ${
                    LEVEL_TONE[level] ?? 'border-line bg-subtle'
                  }`}
                >
                  <time className="tabular font-mono text-[12px] text-ink-3">{formatTime(log.time)}</time>
                  <strong
                    className={`text-[12px] font-bold ${
                      level === 'error' ? 'text-bad-ink' : level === 'warn' ? 'text-warn-ink' : 'text-ok-ink'
                    }`}
                  >
                    {log.level || ''}
                  </strong>
                  <span className="col-span-2 break-all font-mono text-[12px] text-ink-2 sm:col-span-1">
                    {log.message || ''}
                  </span>
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
