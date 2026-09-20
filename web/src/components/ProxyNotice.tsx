import { AlertTriangle, ShieldCheck } from 'lucide-react';

/**
 * 出站代理状态提示。
 *
 * 为什么值得单独做一个显眼的提示：本项目的账号池依赖"多账号分散请求"来
 * 规避上游限流，而**所有账号共用同一个出口 IP 时，上游可以据此把这些账号
 * 关联为同一来源**。实测过一次 8 个账号因风控被同时禁言 3 天，代理未配置
 * 是首要嫌疑——而这在界面上原本完全不可见。
 *
 * 因此：未配置代理时给出明确警示与后果说明，配置后降级为一条安静的状态行，
 * 不制造无谓的视觉噪音。
 */
export function ProxyNotice({ proxyUrl }: { proxyUrl: string | null | undefined }) {
  if (proxyUrl) {
    return (
      <div className="flex items-center gap-2 rounded-xl border border-line bg-subtle px-3 py-2">
        <ShieldCheck size={15} className="shrink-0 text-ok-ink" aria-hidden="true" />
        <span className="min-w-0 truncate text-[12px] text-ink-2">
          出站代理已启用：<code className="font-mono text-ink">{proxyUrl}</code>
        </span>
      </div>
    );
  }

  return (
    <div className="flex items-start gap-2.5 rounded-xl border border-warn/30 bg-warn-soft px-3 py-2.5" role="alert">
      <AlertTriangle size={16} className="mt-0.5 shrink-0 text-warn-ink" aria-hidden="true" />
      <div className="grid min-w-0 gap-0.5">
        <strong className="text-[13px] text-warn-ink">未配置出站代理 · 风控风险</strong>
        <span className="text-[12px] leading-relaxed text-ink-2">
          池中所有账号共用同一出口 IP，上游可据此关联为同一来源，容易触发批量风控。
          建议在部署层配置 <code className="font-mono">HTTPS_PROXY</code> 后重启，并为账号分散出口。
        </span>
      </div>
    </div>
  );
}
