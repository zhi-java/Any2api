import { qwenSettings } from './config.js';

export class QwenRequestQueue {
  constructor(tokenManager) {
    this.tokenManager = tokenManager;
    this.queue = [];
    this.dispatchTimer = null;
  }

  _scheduleDispatch() {
    if (this.dispatchTimer || this.queue.length === 0) return;
    const delay = this.tokenManager.getNextAvailableDelayMs();
    if (delay === null) {
      this._rejectQueued(this.tokenManager.getUnavailableReason?.() || 'No Qwen token is available');
      return;
    }
    this.dispatchTimer = setTimeout(() => {
      this.dispatchTimer = null;
      this.dispatchQueued();
    }, Math.max(25, delay));
  }

  _rejectQueued(reason) {
    while (this.queue.length > 0) {
      const next = this.queue.shift();
      next.reject(new Error(reason));
    }
  }

  enqueueRequest(timeoutMs = qwenSettings.queueTimeoutMs) {
    return new Promise((resolve, reject) => {
      let entry = null;
      let settled = false;

      const settleResolve = (slot) => {
        if (settled) {
          slot?.release?.();
          return;
        }
        settled = true;
        clearTimeout(timer);
        resolve(slot);
      };

      const settleReject = (err) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(err);
      };

      const timer = setTimeout(() => {
        if (entry) {
          const idx = this.queue.indexOf(entry);
          if (idx !== -1) this.queue.splice(idx, 1);
        }
        settleReject(new Error('Request timed out waiting for available Qwen token'));
      }, timeoutMs);

      this.tokenManager.acquireToken()
        .then(slot => {
          if (slot) {
            settleResolve(slot);
            return;
          }

          if (this.queue.length >= qwenSettings.maxQueueSize) {
            settleReject(new Error('Too many queued Qwen requests'));
            return;
          }

          const delay = this.tokenManager.getNextAvailableDelayMs();
          if (delay === null) {
            const reason = this.tokenManager.getUnavailableReason?.() || 'No Qwen token is available';
            settleReject(new Error(reason));
            return;
          }

          entry = { resolve: settleResolve, reject: settleReject };
          this.queue.push(entry);
          this._scheduleDispatch();
        })
        .catch(settleReject);
    });
  }

  async dispatchQueued() {
    while (this.queue.length > 0) {
      const slot = await this.tokenManager.acquireToken();
      if (!slot) {
        const delay = this.tokenManager.getNextAvailableDelayMs();
        if (delay === null) {
          this._rejectQueued(this.tokenManager.getUnavailableReason?.() || 'No Qwen token is available');
        }
        break;
      }
      const next = this.queue.shift();
      next.resolve(slot);
    }
    this._scheduleDispatch();
  }

  getQueueInfo() {
    return {
      queued: this.queue.length,
      maxQueueSize: qwenSettings.maxQueueSize,
      timeoutMs: qwenSettings.queueTimeoutMs,
    };
  }
}
