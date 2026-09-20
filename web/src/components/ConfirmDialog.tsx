import { useCallback, useRef, useState, type ReactNode } from 'react';
import { Button, Modal } from './ui';

/**
 * 危险操作确认对话框，取代 window.confirm。
 *
 * 为什么不用原生 confirm：
 *   1. 样式与设计系统完全脱节（原生弹窗无法定制），在 indigo/圆角体系里很突兀；
 *   2. 阻塞主线程；
 *   3. 无法承载结构化信息 —— 删除凭据这类操作需要讲清"不可恢复""建议改用禁用"，
 *      原生的单行文本既没有层级也难阅读；
 *   4. 移动端与读屏器体验差，且无法控制焦点。
 *
 * 用法：
 *   const confirm = useConfirm();
 *   if (!(await confirm({ title, detail, confirmLabel }))) return;
 */
export interface ConfirmOptions {
  title: string;
  /** 影响说明：讲清后果与替代方案。 */
  detail?: ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  /** danger 使用危险主色（默认），normal 使用常规主色。 */
  tone?: 'danger' | 'normal';
}

type Pending = ConfirmOptions & { resolve: (ok: boolean) => void };

export function useConfirm() {
  const [pending, setPending] = useState<Pending | null>(null);
  // 用 ref 保存 resolve，避免把函数塞进 state 造成不必要的重渲染。
  const resolveRef = useRef<((ok: boolean) => void) | null>(null);

  const confirm = useCallback((options: ConfirmOptions) => {
    return new Promise<boolean>(resolve => {
      resolveRef.current = resolve;
      setPending({ ...options, resolve });
    });
  }, []);

  const settle = useCallback((ok: boolean) => {
    resolveRef.current?.(ok);
    resolveRef.current = null;
    setPending(null);
  }, []);

  const dialog = pending ? (
    <Modal
      title={pending.title}
      hint={pending.tone === 'danger' ? '不可撤销' : undefined}
      onClose={() => settle(false)}
      footer={
        <>
          <Button variant="ghost" onClick={() => settle(false)}>
            {pending.cancelLabel || '取消'}
          </Button>
          <Button
            // 危险操作使用醒目的实心危险色：确认按钮不能与取消按钮看起来同级。
            variant={pending.tone === 'danger' ? 'danger-solid' : 'primary'}
            onClick={() => settle(true)}
          >
            {pending.confirmLabel || '确定'}
          </Button>
        </>
      }
    >
      {pending.detail ? (
        <div className="text-sm leading-relaxed text-ink-2">{pending.detail}</div>
      ) : null}
    </Modal>
  ) : null;

  return { confirm, dialog };
}
