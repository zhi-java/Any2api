import type { ReactNode } from 'react';

export function MetricCard({
  label,
  value,
  hint,
  tone,
}: {
  label: string;
  value: ReactNode;
  hint?: ReactNode;
  tone?: 'ok' | 'warn' | 'bad';
}) {
  const toneCls =
    tone === 'ok' ? 'text-ok' : tone === 'warn' ? 'text-warn-ink' : tone === 'bad' ? 'text-bad' : 'text-ink';
  return (
    <article className="card grid gap-1 p-4">
      <span className="text-[12px] font-semibold text-ink-2">{label}</span>
      <strong className={`tabular text-[26px] font-extrabold leading-tight ${toneCls}`}>{value}</strong>
      {hint ? <small className="text-[12px] text-ink-3">{hint}</small> : null}
    </article>
  );
}

export function MetricGrid({ children }: { children: ReactNode }) {
  return <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">{children}</div>;
}
