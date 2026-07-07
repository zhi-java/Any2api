/**
 * Polling Manager - OmniAPI Admin
 *
 * 管理数据轮询，支持页面可见性检测
 */

class PollingManager {
  /**
   * @param {number} interval - 轮询间隔（毫秒）
   */
  constructor(interval = 5000) {
    this.interval = interval;
    this.timerId = null;
    this.callback = null;
    this.isActive = !document.hidden;

    // 监听页面可见性变化
    document.addEventListener('visibilitychange', () => {
      const wasActive = this.isActive;
      this.isActive = !document.hidden;

      // 页面从隐藏变为可见时，立即执行一次
      if (!wasActive && this.isActive && this.callback) {
        console.log('[Polling] Page visible, updating immediately');
        this.callback();
      }
    });
  }

  /**
   * 启动轮询
   * @param {Function} callback - 轮询回调函数
   */
  start(callback) {
    if (this.timerId) {
      console.warn('[Polling] Already started');
      return;
    }

    this.callback = callback;

    // 立即执行一次
    callback();

    // 启动定时器
    this.timerId = setInterval(() => {
      if (this.isActive) {
        callback();
      }
    }, this.interval);

    console.log(`[Polling] Started with interval ${this.interval}ms`);
  }

  /**
   * 停止轮询
   */
  stop() {
    if (this.timerId) {
      clearInterval(this.timerId);
      this.timerId = null;
      console.log('[Polling] Stopped');
    }
  }

  /**
   * 更新轮询间隔
   * @param {number} interval - 新的轮询间隔（毫秒）
   */
  updateInterval(interval) {
    this.interval = interval;
    if (this.timerId && this.callback) {
      this.stop();
      this.start(this.callback);
    }
  }
}

export default PollingManager;
