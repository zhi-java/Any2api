import { Component, type ErrorInfo, type ReactNode } from 'react';

/**
 * 错误边界：任一页面渲染抛错时兜住，避免整个控制台白屏。
 *
 * 为什么必须有：React 在渲染期间抛出的错误会卸载整棵组件树。没有错误边界
 * 时，后台会变成一片空白——用户看不到任何信息，也无法自救，只能刷新（往往
 * 还会再崩）。对运维面板而言这是硬伤：连"出了什么错"都无从得知。
 *
 * 用 class 组件是必需的：React 目前仅支持以 getDerivedStateFromError /
 * componentDidCatch 实现错误边界，没有对应的 Hook。
 */
interface Props {
  children: ReactNode;
  /** 出错时用于恢复的回调（如切回首页），可选。 */
  onReset?: () => void;
}

interface State {
  error: Error | null;
  info: ErrorInfo | null;
}

export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null, info: null };

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    // 控制台保留完整栈，便于排障；UI 上只给出可读摘要。
    console.error('[ErrorBoundary] 页面渲染出错:', error, info.componentStack);
    this.setState({ info });
  }

  private reset = () => {
    this.setState({ error: null, info: null });
    this.props.onReset?.();
  };

  render() {
    const { error, info } = this.state;
    if (!error) return this.props.children;

    return (
      <div className="grid gap-3">
        <div className="card grid gap-3 p-5">
          <div className="grid gap-1">
            <span className="text-[12px] font-bold uppercase tracking-[0.14em] text-bad-ink">
              Render Error
            </span>
            <h2 className="m-0 text-[18px] font-extrabold text-ink">这个页面出错了</h2>
            <p className="m-0 text-sm text-ink-2">
              其它页面仍可正常使用。你可以重试，或先回到首页。
            </p>
          </div>

          <pre className="max-h-[240px] overflow-auto rounded-xl border border-bad/30 bg-bad-soft p-3 font-mono text-[12px] text-bad-ink">
            {error.message || String(error)}
          </pre>

          {info?.componentStack ? (
            <details className="text-[12px] text-ink-3">
              <summary className="cursor-pointer select-none font-semibold">组件栈</summary>
              <pre className="mt-2 max-h-[220px] overflow-auto whitespace-pre-wrap font-mono">
                {info.componentStack.trim()}
              </pre>
            </details>
          ) : null}

          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              onClick={this.reset}
              className="min-h-[42px] cursor-pointer rounded-xl bg-accent px-4 py-2.5 text-sm font-bold text-white shadow-[0_8px_20px_rgba(79,70,229,0.22)] transition hover:bg-accent-hover"
            >
              重试
            </button>
            <a
              href="#dashboard"
              onClick={this.reset}
              className="inline-flex min-h-[42px] cursor-pointer items-center rounded-xl border border-line bg-surface px-4 py-2.5 text-sm font-bold text-ink transition hover:border-line-strong"
            >
              回到首页
            </a>
          </div>
        </div>
      </div>
    );
  }
}
