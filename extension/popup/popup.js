/* popup.js — 点击插件图标弹出：开关对读 + 快速设置（见 shared/quick-setup.js）+ 中英切换 */
(async () => {
  'use strict';
  const PT = globalThis.PT;
  const t = PT.t;
  const $ = (id) => document.getElementById(id);
  const qTab = new URLSearchParams(location.search).get('tab');   // 测试时可指定标签页
  const tabId = qTab ? +qTab : ((await chrome.tabs.query({ active: true, currentWindow: true }))[0] || {}).id;
  let splitState = null;

  const qs = await PT.mountQuickSetup(document, { onChange: () => renderToggle() });

  function renderAll() {
    document.documentElement.lang = PT.i18n.lang === 'zh' ? 'zh-CN' : 'en';
    PT.i18n.apply(document);
    for (const b of $('uiLang').children) b.classList.toggle('on', b.dataset.v === PT.i18n.lang);
    renderToggle();
    qs.render();
  }
  for (const b of $('uiLang').children) b.onclick = async () => { await qs.setUiLang(b.dataset.v); renderAll(); };

  function renderToggle() {
    const b = $('toggle');
    if (tabId == null) { b.textContent = t('pop.noTab'); b.disabled = true; return; }
    if (!splitState) return;
    if (splitState === 'unavailable') { b.textContent = t('pop.unavailable'); b.disabled = true; return; }
    b.disabled = false;
    b.textContent = splitState === 'on' ? t('pop.off') : t('pop.on');
    b.classList.toggle('off', splitState === 'on');
  }
  async function refreshToggle() {
    if (tabId == null) return renderToggle();
    splitState = (await chrome.runtime.sendMessage({ type: 'splitState', tabId })).state;
    renderToggle();
  }
  $('toggle').onclick = async () => {
    await qs.flushSave();
    // 开启前先确认引擎可用：没填 Key 就在这里提示，而不是开了分屏才报错
    if (splitState !== 'on' && !qs.ready()) { qs.demandKey(); return; }
    $('toggle').disabled = true;
    await chrome.runtime.sendMessage({ type: 'toggle', tabId });
    if (!qTab) window.close(); else setTimeout(refreshToggle, 300);
  };
  $('more').onclick = (e) => { e.preventDefault(); chrome.runtime.openOptionsPage(); };

  renderAll();
  refreshToggle();
})();
