import { useState, type ReactNode } from 'react';
import { ROUTES, type RouteId } from '../lib/router';

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

export function LoginView({
  onSubmit,
}: {
  onSubmit: (apiKey: string) => Promise<void>;
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

  return (
    <div
      className="grid min-h-screen place-items-center p-6"
      style={{
        background:
          'radial-gradient(circle at 18% 10%, rgba(79,70,229,0.10), transparent 28%), radial-gradient(circle at 88% 8%, rgba(6,182,212,0.08), transparent 24%), var(--color-canvas)',
      }}
    >
      <form onSubmit={submit} className="card grid w-full max-w-[420px] gap-3.5 p-7">
        <BrandMark />
        <h1 className="m-0 text-[26px] font-extrabold tracking-[-0.03em]">OmniAPI 控制台</h1>
        <p className="m-0 text-sm leading-relaxed text-ink-2">
          登录后查看服务状态、复制接入地址，并管理渠道与凭据。
        </p>
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
          <div className="rounded-xl border border-bad/30 bg-bad-soft px-3 py-2.5 text-sm text-bad" role="alert">
            {error}
          </div>
        ) : null}
        <button
          type="submit"
          disabled={busy}
          className="min-h-[42px] rounded-xl bg-accent px-4 py-2.5 text-sm font-bold text-white shadow-[0_8px_20px_rgba(79,70,229,0.22)] transition hover:bg-accent-hover disabled:opacity-60"
        >
          {busy ? '登录中…' : '登录'}
        </button>
      </form>
    </div>
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

  return (
    <div className="grid min-h-screen grid-cols-[248px_1fr] max-lg:grid-cols-1">
      <aside className="border-r border-line bg-surface p-4 max-lg:hidden">
        <div className="mb-6 flex items-center gap-3 px-1.5">
          <BrandMark size={38} />
          <div className="grid">
            <strong className="text-[15px]">OmniAPI</strong>
            <span className="text-[12px] text-ink-3">本地 AI 网关</span>
          </div>
        </div>
        <nav className="grid gap-1" aria-label="主导航">
          {ROUTES.map(item => {
            const active = item.id === route;
            return (
              <a
                key={item.id}
                href={`#${item.id}`}
                aria-current={active ? 'page' : undefined}
                className={`rounded-xl px-3 py-2.5 text-sm font-semibold transition-colors ${
                  active
                    ? 'bg-accent-soft text-accent'
                    : 'text-ink-2 hover:bg-subtle hover:text-ink'
                }`}
              >
                {item.label}
              </a>
            );
          })}
        </nav>
      </aside>

      <main className="min-w-0">
        <header className="flex items-center justify-between gap-4 border-b border-line bg-canvas/80 px-7 py-5 backdrop-blur max-lg:px-4">
          <div>
            <p className="m-0 text-[12px] font-bold uppercase tracking-[0.14em] text-accent">
              {current.eyebrow}
            </p>
            <h1 className="m-0 text-[24px] font-extrabold tracking-[-0.02em]">{current.label}</h1>
          </div>
          <button
            type="button"
            onClick={onLogout}
            title="退出登录"
            aria-label="退出登录"
            className="rounded-xl border border-line bg-surface px-3 py-2 text-ink-2 transition hover:border-line-strong hover:text-ink"
          >
            <svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true">
              <path
                d="M10 4a1 1 0 0 1 1 1v2a1 1 0 1 1-2 0V6H6v12h3v-1a1 1 0 1 1 2 0v2a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1h5Zm6.3 4.3 3 3a1 1 0 0 1 0 1.4l-3 3a1 1 0 1 1-1.4-1.4l1.29-1.3H10a1 1 0 1 1 0-2h6.19L14.9 9.7a1 1 0 0 1 1.4-1.4Z"
                fill="currentColor"
              />
            </svg>
          </button>
        </header>

        <div className="p-7 max-lg:p-4" aria-live="polite">
          {children}
        </div>
      </main>
    </div>
  );
}
