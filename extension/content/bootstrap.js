/*
 * bootstrap.js — 静态注入到所有页面的所有 frame，尽量轻：
 *   - 若本 frame 是分屏窗格（window.name 带标记），请求 SW 注入完整的窗格代理；
 *   - 顶层 frame 记录最近一次右键的位置（"对读：从这里开始"）。
 */
(() => {
  if (window.top !== window) {
    if (/^__pt:[LR]:[a-z0-9]+$/.test(window.name || '')) {
      chrome.runtime.sendMessage({ type: 'pane:hello' }).catch(() => {});
    }
    return;
  }
  window.addEventListener('contextmenu', (e) => { globalThis.__ptCtxTarget = e.target; }, true);
})();
