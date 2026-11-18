/* welcome.js — 安装后自动打开的引导页：固定图标 → 选引擎填 Key → 一键试用 */
(async () => {
  'use strict';
  const PT = globalThis.PT;
  const t = PT.t;
  const $ = (id) => document.getElementById(id);
  const demoParam = new URLSearchParams(location.search).get('demo');   // 测试可指定示例页
  const qs = await PT.mountQuickSetup(document);

  // 当前快捷键（用户可能改过）
  let shortcut = 'Alt+Shift+Y';
  try {
    const cmd = (await chrome.commands.getAll()).find((c) => c.name === 'toggle-split');
    if (cmd && cmd.shortcut) shortcut = cmd.shortcut;
  } catch (_) { /* 忽略 */ }

  function sampleUrl() {
    if (demoParam) return demoParam;
    // 目标是英文时用德文示例页，其余用英文维基百科
    return /^en/.test(qs.settings.targetLang) ? 'https://de.wikipedia.org/wiki/Typografie' : 'https://en.wikipedia.org/wiki/Typography';
  }

  function renderAll() {
    document.documentElement.lang = PT.i18n.lang === 'zh' ? 'zh-CN' : 'en';
    document.title = t('wel.title');
    PT.i18n.apply(document);
    const s3 = $('s3d');
    s3.textContent = '';
    const [before, after] = t('wel.s3d').split('{key}');
    const kbd = document.createElement('kbd'); kbd.textContent = shortcut;
    s3.append(before, kbd, after || '');
    for (const b of $('uiLang').children) b.classList.toggle('on', b.dataset.v === PT.i18n.lang);
    qs.render();
  }
  for (const b of $('uiLang').children) b.onclick = async () => { await qs.setUiLang(b.dataset.v); renderAll(); };

  $('try').onclick = async () => {
    await qs.flushSave();
    const out = $('tryOut');
    if (!qs.ready()) { qs.demandKey(); out.className = 'err'; out.textContent = t('pop.needKey'); return; }
    out.className = ''; out.textContent = '';
    await chrome.runtime.sendMessage({ type: 'tryDemo', url: sampleUrl() });
  };
  $('more').onclick = (e) => { e.preventDefault(); chrome.runtime.openOptionsPage(); };

  renderAll();
})();
