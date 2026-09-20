import { useEffect, useRef, useState, type ReactNode } from 'react';
import { LogOut, Menu, X } from 'lucide-react';
import { NAV_GROUPS, ROUTES, type RouteId } from '../lib/router';
import { usePolling } from '../lib/hooks';
import { api } from '../lib/api';

export function BrandMark({ size = 42 }: { size?: number }) {
  return (
    <div
      className="grid shrink-0 place-items-center rounded-[14px] font-extrabold text-white"
      style={{
        width: size,
        height: size,
        background: 'linear-gradient(135deg, #6366f1, #4f46e5 55%, #06b6d4)',
        boxShadow: '0 12px 28px rgba(79, 70, 229, 0.28)',
      }}
    >
      O
    </div>
  );
}

/**
 * 登录视图。两种用法：
 *   1. 未登录时的整页登录（默认标题）；
 *   2. 会话过期时作为覆盖层复用（传 title/description/submitLabel），
 *      此时不渲染整页背景，由调用方提供遮罩。
 */
export function LoginView({
  onSubmit,
  title = 'OmniAPI 控制台',
  description = '登录后查看服务状态、复制接入地址，并管理渠道与凭据。',
  submitLabel = '登录',
  embedded = false,
}: {
  onSubmit: (apiKey: string) => Promise<void>;
  title?: string;
  description?: string;
  submitLabel?: string;
  /** true 表示已被外层遮罩包裹，不再渲染整页背景。 */
  embedded?: boolean;
}) {
  const [apiKey, setApiKey] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setError('');
    setBusy(true);
    try {
      await onSubmit(apiKey.trim());
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setError(message === 'Invalid API key' ? 'API Key 无效' : message);
    } finally {
      setBusy(false);
    }
  }

  const form = (
    <form onSubmit={submit} className="card grid w-full max-w-[420px] gap-3.5 p-7">
      <BrandMark />
      <h1 className="m-0 text-[26px] font-extrabold tracking-[-0.03em]">{title}</h1>
      <p className="m-0 text-sm leading-relaxed text-ink-2">{description}</p>
        <label className="grid gap-1.5">
          <span className="text-[13px] font-semibold text-ink-2">API Key</span>
          <input
            className="min-h-[42px] w-full rounded-xl border border-line-strong bg-surface px-3 py-2 text-sm outline-none focus:border-accent focus:ring-4 focus:ring-accent/15"
            type="password"
            autoComplete="current-password"
            placeholder="sk-..."
            value={apiKey}
            onChange={event => setApiKey(event.target.value)}
          />
        </label>
        {error ? (
          <div className="rounded-xl border border-bad/30 bg-bad-soft px-3 py-2.5 text-sm text-bad-ink" role="alert">
            {error}
          </div>
        ) : null}
        <button
          type="submit"
          disabled={busy}
          className="min-h-[42px] cursor-pointer rounded-xl bg-accent px-4 py-2.5 text-sm font-bold text-white shadow-[0_8px_20px_rgba(79,70,229,0.22)] transition hover:bg-accent-hover disabled:cursor-not-allowed disabled:opacity-60"
        >
          {busy ? '登录中…' : submitLabel}
        </button>
      </form>
  );

  // embedded：由调用方提供遮罩，这里只交出表单本身。
  if (embedded) return form;

  return (
    <div
      className="grid min-h-screen place-items-center p-6"
      style={{
        background:
          'radial-gradient(circle at 18% 10%, rgba(79,70,229,0.10), transparent 28%), radial-gradient(circle at 88% 8%, rgba(6,182,212,0.08), transparent 24%), var(--color-canvas)',
      }}
    >
      {form}
    </div>
  );
}

/** 侧栏底部的全局健康指示：运维面板的核心价值是"扫一眼知道有没有事"。 */
function PoolStatus() {
  const { data } = usePolling(() => api.getStats(), 30_000);
  if (!data) return null;

  const channel = data.channels?.[0];
  const available = channel?.availableCount ?? 0;
  const disabled = channel?.disabledCount ?? 0;
  const healthy = channel?.status === 'healthy';

  return (
    <div className="grid gap-1.5 rounded-xl border border-line bg-subtle p-3">
      <div className="flex items-center gap-2">
        <span
          className={`h-2 w-2 shrink-0 rounded-full ${healthy ? 'bg-ok' : 'bg-bad'}`}
          aria-hidden="true"
        />
        <strong className="text-[12px] text-ink">
          {healthy ? '运行正常' : '需要关注'}
        </strong>
      </div>
      <span className="text-[12px] text-ink-3">
        {available} 个凭据可用
        {disabled > 0 ? ` · ${disabled} 个已禁用` : ''}
      </span>
      {/* 未配置代理时在此也提示一句：风控是账号池最致命的故障模式，
          不该只在首页可见。 */}
      {!data.proxyUrl ? (
        <span className="text-[12px] font-semibold text-warn-ink">未配置出站代理</span>
      ) : null}
      <span className="text-[11px] text-ink-3">v{data.version}</span>
    </div>
  );
}

function NavLinks({ route, onNavigate }: { route: RouteId; onNavigate?: () => void }) {
  return (
    <nav className="grid gap-4" aria-label="主导航">
      {NAV_GROUPS.map(group => (
        <div key={group.title} className="grid gap-1">
          <span className="px-3 text-[11px] font-bold uppercase tracking-[0.12em] text-ink-3">
            {group.title}
          </span>
          {group.items.map(item => {
            const active = item.id === route;
            const Icon = item.icon;
            return (
              <a
                key={item.id}
                href={`#${item.id}`}
                onClick={onNavigate}
                aria-current={active ? 'page' : undefined}
                className={`flex cursor-pointer items-center gap-2.5 rounded-xl px-3 py-2.5 text-sm font-semibold transition-colors ${
                  active ? 'bg-accent-soft text-accent' : 'text-ink-2 hover:bg-subtle hover:text-ink'
                }`}
              >
                <Icon size={17} aria-hidden="true" className="shrink-0" />
                {item.label}
              </a>
            );
          })}
        </div>
      ))}
    </nav>
  );
}

export function Shell({
  route,
  onLogout,
  children,
}: {
  route: RouteId;
  onLogout: () => void;
  children: ReactNode;
}) {
  const current = ROUTES.find(item => item.id === route) ?? ROUTES[0];
  const [drawerOpen, setDrawerOpen] = useState(false);
  const drawerRef = useRef<HTMLDivElement | null>(null);

  // 路由变化时自动关闭抽屉：点完导航项不该还停留在遮罩上。
  useEffect(() => {
    setDrawerOpen(false);
  }, [route]);

  // 抽屉打开时：Esc 关闭 + 焦点移入 + 锁滚动。
  useEffect(() => {
    if (!drawerOpen) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setDrawerOpen(false);
    };
    document.addEventListener('keydown', onKeyDown);
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    drawerRef.current?.focus();
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      document.body.style.overflow = prevOverflow;
    };
  }, [drawerOpen]);

  return (
    <div className="grid min-h-screen grid-cols-[248px_minmax(0,1fr)] max-lg:grid-cols-1">
      {/* 桌面侧栏 */}
      <aside className="flex flex-col gap-4 border-r border-line bg-surface p-4 max-lg:hidden">
        <div className="flex items-center gap-3 px-1.5">
          <BrandMark size={38} />
          <div className="grid">
            <strong className="text-[15px]">OmniAPI</strong>
            <span className="text-[12px] text-ink-3">AI 网关控制台</span>
          </div>
        </div>
        <NavLinks route={route} />
        <div className="mt-auto">
          <PoolStatus />
        </div>
      </aside>

      {/* 移动端抽屉：窄屏下侧栏隐藏，若无此入口则完全无法切换页面 */}
      {drawerOpen ? (
        <div className="fixed inset-0 z-50 lg:hidden">
          <div
            className="absolute inset-0 bg-ink/30 backdrop-blur-[2px]"
            onClick={() => setDrawerOpen(false)}
            aria-hidden="true"
          />
          <div
            ref={drawerRef}
            role="dialog"
            aria-modal="true"
            aria-label="导航菜单"
            tabIndex={-1}
            className="relative z-10 flex h-full w-[272px] max-w-[85vw] flex-col gap-4 overflow-y-auto bg-surface p-4 shadow-[var(--shadow-card)] outline-none"
          >
            <div className="flex items-center justify-between gap-2">
              <div className="flex items-center gap-3">
                <BrandMark size={34} />
                <strong className="text-[15px]">OmniAPI</strong>
              </div>
              <button
                type="button"
                onClick={() => setDrawerOpen(false)}
                aria-label="关闭导航"
                className="cursor-pointer rounded-lg p-2 text-ink-3 transition hover:bg-subtle hover:text-ink"
              >
                <X size={18} aria-hidden="true" />
              </button>
            </div>
            <NavLinks route={route} onNavigate={() => setDrawerOpen(false)} />
            <div className="mt-auto">
              <PoolStatus />
            </div>
          </div>
        </div>
      ) : null}

      <main className="min-w-0">
        <header className="flex items-center justify-between gap-4 border-b border-line bg-canvas/80 px-7 py-5 backdrop-blur max-lg:px-4">
          <div className="flex min-w-0 items-center gap-3">
            <button
              type="button"
              onClick={() => setDrawerOpen(true)}
              aria-label="打开导航菜单"
              aria-expanded={drawerOpen}
              className="cursor-pointer rounded-xl border border-line bg-surface p-2 text-ink-2 transition hover:border-line-strong hover:text-ink lg:hidden"
            >
              <Menu size={18} aria-hidden="true" />
            </button>
            <div className="min-w-0">
              <p className="m-0 text-[12px] font-bold uppercase tracking-[0.14em] text-accent">
                {current.eyebrow}
              </p>
              <h1 className="m-0 truncate text-[24px] font-extrabold tracking-[-0.02em]">{current.label}</h1>
            </div>
          </div>
          <button
            type="button"
            onClick={onLogout}
            title="退出登录"
            aria-label="退出登录"
            className="flex cursor-pointer items-center gap-2 rounded-xl border border-line bg-surface px-3 py-2 text-ink-2 transition hover:border-line-strong hover:text-ink"
          >
            <LogOut size={16} aria-hidden="true" />
            <span className="hidden text-sm font-semibold sm:inline">退出</span>
          </button>
        </header>

        {/* 这里刻意不加 aria-live：包住整个内容区会让每次轮询刷新（10~15 秒一次）
            都触发读屏器播报，成为噪音源。该播报的是操作结果，已由 Toast 承担
            （见 ui.tsx 的 ToastProvider）。 */}
        <div className="mx-auto w-full max-w-[1440px] p-7 max-lg:p-4">
          {children}
        </div>
      </main>
    </div>
  );
}
