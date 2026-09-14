import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react';
import type { ChannelStatus } from '../types';
import { statusLabel, statusTone } from '../lib/format';

// ============================================================
// 基础 UI 组件（S4 Soft Product）
// ============================================================

export function Card({ children, className = '' }: { children: ReactNode; className?: string }) {
  return <section className={`card p-5 ${className}`}>{children}</section>;
}

export function PanelHeader({
  title,
  hint,
  action,
}: {
  title: string;
  hint?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="mb-3 flex items-center justify-between gap-3">
      <h2 className="text-[16px] font-bold text-ink">{title}</h2>
      <div className="flex items-center gap-3 text-[12px] font-semibold text-ink-3">
        {hint}
        {action}
      </div>
    </div>
  );
}

const BADGE_TONE = {
  ok: 'bg-ok-soft text-ok border-ok-line',
  warn: 'bg-warn-soft text-warn-ink border-warn/30',
  bad: 'bg-bad-soft text-bad border-bad/30',
  muted: 'bg-subtle text-ink-2 border-line',
  accent: 'bg-accent-soft text-accent border-line-accent',
} as const;

export function Badge({
  tone = 'muted',
  children,
}: {
  tone?: keyof typeof BADGE_TONE;
  children: ReactNode;
}) {
  return (
    <span
      className={`inline-flex items-center rounded-full border px-2.5 py-0.5 text-[12px] font-semibold ${BADGE_TONE[tone]}`}
    >
      {children}
    </span>
  );
}

export function StatusBadge({ status }: { status: ChannelStatus }) {
  return <Badge tone={statusTone(status)}>{statusLabel(status)}</Badge>;
}

const BTN_VARIANT = {
  primary: 'bg-accent text-white hover:bg-accent-hover shadow-[0_8px_20px_rgba(79,70,229,0.22)]',
  secondary: 'bg-accent-soft text-accent hover:bg-line-accent/50',
  ghost: 'bg-surface text-ink border border-line hover:border-line-strong',
  danger: 'bg-surface text-bad border border-bad/30 hover:bg-bad-soft',
} as const;

type ButtonProps = React.ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: keyof typeof BTN_VARIANT;
  size?: 'sm' | 'md';
};

export function Button({ variant = 'primary', size = 'md', className = '', ...rest }: ButtonProps) {
  const sizeCls = size === 'sm' ? 'px-3 py-1.5 text-[13px]' : 'px-4 py-2.5 text-sm';
  return (
    <button
      type="button"
      {...rest}
      className={`inline-flex items-center justify-center gap-1.5 rounded-xl font-bold transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${sizeCls} ${BTN_VARIANT[variant]} ${className}`}
    />
  );
}

export function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: ReactNode;
  children: ReactNode;
}) {
  return (
    <label className="grid gap-1.5">
      <span className="text-[13px] font-semibold text-ink-2">{label}</span>
      {children}
      {hint ? <span className="text-[12px] text-ink-3">{hint}</span> : null}
    </label>
  );
}

export function Input({ className = '', ...rest }: React.InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      {...rest}
      className={`min-h-[42px] w-full rounded-xl border border-line-strong bg-surface px-3 py-2 text-sm text-ink outline-none transition focus:border-accent focus:ring-4 focus:ring-accent/15 ${className}`}
    />
  );
}

export function Select({ className = '', ...rest }: React.SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select
      {...rest}
      className={`min-h-[42px] rounded-xl border border-line-strong bg-surface px-3 py-2 text-sm text-ink outline-none transition focus:border-accent focus:ring-4 focus:ring-accent/15 ${className}`}
    />
  );
}

export function Switch({
  checked,
  onChange,
  label,
}: {
  checked: boolean;
  onChange: (next: boolean) => void;
  label: string;
}) {
  return (
    <label className="flex cursor-pointer items-center gap-2.5 text-sm text-ink">
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        onClick={() => onChange(!checked)}
        className={`relative h-6 w-11 shrink-0 rounded-full border transition-colors ${
          checked ? 'border-accent bg-accent' : 'border-line-strong bg-line'
        }`}
      >
        <span
          className={`absolute top-0.5 h-4.5 w-4.5 rounded-full bg-white shadow transition-all ${
            checked ? 'left-[22px]' : 'left-0.5'
          }`}
        />
      </button>
      {label}
    </label>
  );
}

export function EmptyState({ title, detail }: { title: string; detail?: string }) {
  return (
    <div className="grid place-items-center gap-1 rounded-xl border border-dashed border-line-strong bg-subtle px-4 py-8 text-center">
      <strong className="text-sm text-ink">{title}</strong>
      {detail ? <span className="text-[12px] text-ink-3">{detail}</span> : null}
    </div>
  );
}

export function Skeleton({ className = 'h-24' }: { className?: string }) {
  return <div className={`animate-pulse rounded-2xl bg-line/60 ${className}`} />;
}

// ============================================================
// Toast
// ============================================================

type Tone = 'info' | 'success' | 'warning' | 'danger';
interface ToastItem {
  id: number;
  message: string;
  tone: Tone;
}

const ToastContext = createContext<(message: string, tone?: Tone) => void>(() => {});

export function useToast() {
  return useContext(ToastContext);
}

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);

  const push = useCallback((message: string, tone: Tone = 'info') => {
    const id = Date.now() + Math.random();
    setItems(prev => [...prev, { id, message, tone }]);
    window.setTimeout(() => setItems(prev => prev.filter(item => item.id !== id)), 3200);
  }, []);

  const toneCls: Record<Tone, string> = useMemo(
    () => ({
      info: 'border-line bg-surface text-ink',
      success: 'border-ok-line bg-ok-soft text-ok',
      warning: 'border-warn/30 bg-warn-soft text-warn-ink',
      danger: 'border-bad/30 bg-bad-soft text-bad',
    }),
    [],
  );

  return (
    <ToastContext.Provider value={push}>
      {children}
      <div className="pointer-events-none fixed bottom-6 right-6 z-50 grid gap-2">
        {items.map(item => (
          <div
            key={item.id}
            className={`pointer-events-auto rounded-xl border px-4 py-2.5 text-sm font-semibold shadow-[var(--shadow-soft)] ${toneCls[item.tone]}`}
          >
            {item.message}
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

// ============================================================
// 模态
// ============================================================

export function Modal({
  title,
  hint,
  onClose,
  children,
  footer,
}: {
  title: string;
  hint?: ReactNode;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
}) {
  return (
    <div className="fixed inset-0 z-50 grid place-items-center p-6">
      <div className="absolute inset-0 bg-ink/20 backdrop-blur-[2px]" onClick={onClose} />
      <div className="card relative z-10 max-h-[85vh] w-full max-w-2xl overflow-auto p-6">
        <PanelHeader
          title={title}
          hint={hint}
          action={
            <button
              type="button"
              onClick={onClose}
              aria-label="关闭"
              className="rounded-lg px-2 py-1 text-ink-3 hover:bg-subtle hover:text-ink"
            >
              ✕
            </button>
          }
        />
        {children}
        {footer ? <div className="mt-4 flex justify-end gap-2">{footer}</div> : null}
      </div>
    </div>
  );
}
