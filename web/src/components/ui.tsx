import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
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
  titleId,
}: {
  title: string;
  hint?: ReactNode;
  action?: ReactNode;
  /** 供 Modal 的 aria-labelledby 关联标题。 */
  titleId?: string;
}) {
  return (
    <div className="mb-3 flex items-center justify-between gap-3">
      <h2 id={titleId} className="text-[16px] font-bold text-ink">{title}</h2>
      <div className="flex items-center gap-3 text-[12px] font-semibold text-ink-3">
        {hint}
        {action}
      </div>
    </div>
  );
}

const BADGE_TONE = {
  ok: 'bg-ok-soft text-ok-ink border-ok-line',
  warn: 'bg-warn-soft text-warn-ink border-warn/30',
  bad: 'bg-bad-soft text-bad-ink border-bad/30',
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
  danger: 'bg-surface text-bad-ink border border-bad/30 hover:bg-bad-soft',
  // 实心危险按钮：用于确认对话框的主操作。用 bad-ink(#b91c1c) 作底色，
  // 白字对比度 6.47:1（bad 亮色 #ef4444 只有 3.76:1，不足以承载正文）。
  'danger-solid': 'bg-bad-ink text-white hover:bg-bad shadow-[0_8px_20px_rgba(185,28,28,0.22)]',
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
      // cursor-pointer 是必需的：Tailwind v4 的 preflight 把 button 默认设为
      // cursor: default，若不显式声明，所有按钮悬停时都不会显示手型光标。
      className={`inline-flex cursor-pointer items-center justify-center gap-1.5 rounded-xl font-bold transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${sizeCls} ${BTN_VARIANT[variant]} ${className}`}
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
        // 视觉 label 在 button 之外，按钮自身需要一个可访问名，否则读屏器
        // 只会念出"开关"而不知其含义。
        aria-label={label}
        onClick={() => onChange(!checked)}
        className={`relative h-6 w-11 shrink-0 cursor-pointer rounded-full border transition-colors ${
          checked ? 'border-accent bg-accent' : 'border-line-strong bg-line'
        }`}
      >
        <span
          className={`absolute top-1/2 h-[18px] w-[18px] -translate-y-1/2 rounded-full bg-white shadow transition-[left] ${
            checked ? 'left-[21px]' : 'left-[3px]'
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
      success: 'border-ok-line bg-ok-soft text-ok-ink',
      warning: 'border-warn/30 bg-warn-soft text-warn-ink',
      danger: 'border-bad/30 bg-bad-soft text-bad-ink',
    }),
    [],
  );

  return (
    <ToastContext.Provider value={push}>
      {children}
      {/* role=status + aria-live=polite 让读屏器播报操作结果。
          此前 Toast 是纯视觉的，而页面内容区却包了 aria-live —— 优先级正好
          反了：真正该播报的"保存成功/删除失败"被漏掉，轮询刷新反而会吵。 */}
      <div
        role="status"
        aria-live="polite"
        aria-atomic="false"
        className="pointer-events-none fixed bottom-6 right-6 z-50 grid gap-2"
      >
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

/**
 * 模态框（含完整键盘与读屏器支持）。
 *
 * 补上了三项 WAI-ARIA 对话框的必要能力，缺任一项都会让键盘/读屏器用户
 * 无法正常使用（此前三者皆无）：
 *   1. role="dialog" + aria-modal + aria-labelledby —— 声明这是对话框并关联标题；
 *   2. Esc 关闭 —— 键盘用户的预期逃生通道；
 *   3. 焦点管理 —— 打开时移入弹窗、关闭后归还触发元素；Tab 在弹窗内循环，
 *      避免焦点跑到被遮罩的页面内容上（背景内容对键盘用户实际不可达）。
 */
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
  const panelRef = useRef<HTMLDivElement | null>(null);
  const titleId = useId();

  useEffect(() => {
    // 记录触发元素，关闭后把焦点还回去（否则焦点会丢失到 body）。
    const previouslyFocused = document.activeElement as HTMLElement | null;

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        onClose();
        return;
      }
      if (event.key !== 'Tab' || !panelRef.current) return;

      // 焦点陷阱：Tab 在弹窗内首尾循环。
      const focusables = panelRef.current.querySelectorAll<HTMLElement>(
        'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])',
      );
      if (focusables.length === 0) return;
      const first = focusables[0];
      const last = focusables[focusables.length - 1];
      if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      } else if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      }
    };

    document.addEventListener('keydown', onKeyDown, true);
    return () => {
      document.removeEventListener('keydown', onKeyDown, true);
      previouslyFocused?.focus?.();
    };
  }, [onClose]);

  return (
    <div className="fixed inset-0 z-50 grid place-items-center p-6">
      <div className="absolute inset-0 bg-ink/20 backdrop-blur-[2px]" onClick={onClose} aria-hidden="true" />
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className="card relative z-10 max-h-[85vh] w-full max-w-2xl overflow-auto p-6"
      >
        <PanelHeader
          title={title}
          hint={hint}
          titleId={titleId}
          action={
            <button
              type="button"
              onClick={onClose}
              aria-label="关闭"
              className="cursor-pointer rounded-lg px-2 py-1 text-ink-3 hover:bg-subtle hover:text-ink"
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
