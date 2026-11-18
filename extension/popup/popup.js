/* popup.js — 点击插件图标弹出：开关对读 + 选引擎 + 填 API Key/地址/模型 + 测试 + 中英切换。修改即自动保存。 */
(async () => {
  'use strict';
  const PT = globalThis.PT;
  const t = PT.t;
  const $ = (id) => document.getElementById(id);
  const qTab = new URLSearchParams(location.search).get('tab');   // 测试时可指定标签页
  const tabId = qTab ? +qTab : ((await chrome.tabs.query({ active: true, currentWindow: true }))[0] || {}).id;

  // 每种引擎在弹窗里显示的字段（其余参数在"更多设置"）：[key, 标签, 类型, 占位]
  const QUICK = {
    openai: [['apiKey', 'f.apiKey', 'password', 'f.apiKey.ph'], ['baseUrl', 'f.baseUrl', 'text', 'f.baseUrl.ph'], ['model', 'f.model', 'text', '']],
    deepl: [['apiKey', 'f.deeplKey', 'password', ''], ['endpoint', 'f.endpoint', 'text', 'f.endpoint.ph']],
    mock: [],
  };

  let settings = await PT.loadSettings();
  const cur = () => settings.providers.find((p) => p.id === settings.activeProviderId) || settings.providers[0];
  let splitState = null;

  /* ---------- 界面语言 ---------- */
  function renderAll() {
    document.documentElement.lang = PT.i18n.lang === 'zh' ? 'zh-CN' : 'en';
    PT.i18n.apply(document);
    for (const b of $('uiLang').children) b.classList.toggle('on', b.dataset.v === PT.i18n.lang);
    renderToggle();
    renderEngine();
  }
  for (const b of $('uiLang').children) {
    b.onclick = async () => { await flushSave(); settings.uiLang = b.dataset.v; await save(); renderAll(); };
  }

  /* ---------- 对读开关 ---------- */
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
    $('toggle').disabled = true;
    await flushSave();
    await chrome.runtime.sendMessage({ type: 'toggle', tabId });
    if (!qTab) window.close(); else setTimeout(refreshToggle, 300);
  };

  /* ---------- 引擎 / 字段 ---------- */
  function renderEngine() {
    $('engine').innerHTML = settings.providers.map((p) => `<option value="${p.id}">${esc(PT.provName(p))}</option>`).join('');
    $('engine').value = cur().id;
    const p = cur();
    const box = $('fields');
    box.innerHTML = '';
    if (p.type === 'mock') {
      const n = document.createElement('div'); n.className = 'note'; n.textContent = t('pop.mockNote'); box.append(n);
    }
    for (const [key, label, type, ph] of QUICK[p.type] || []) {
      const l = document.createElement('label');
      l.append(t(label));
      const inp = document.createElement('input');
      inp.type = type; inp.placeholder = ph ? t(ph) : ''; inp.value = p[key] || ''; inp.id = 'f-' + key;
      inp.spellcheck = false; inp.autocomplete = 'off';
      inp.oninput = () => { p[key] = inp.value.trim(); scheduleSave(); };
      if (type === 'password') {
        const row = document.createElement('div'); row.className = 'keyrow';
        const eye = document.createElement('button'); eye.type = 'button'; eye.textContent = t('pop.show');
        eye.onclick = () => { inp.type = inp.type === 'password' ? 'text' : 'password'; eye.textContent = t(inp.type === 'password' ? 'pop.show' : 'pop.hide'); };
        row.append(inp, eye); l.append(row);
      } else l.append(inp);
      box.append(l);
    }
    $('testOut').textContent = ''; $('testOut').className = '';
  }
  $('engine').onchange = async () => { await flushSave(); settings.activeProviderId = $('engine').value; await save(); renderEngine(); };

  $('lang').innerHTML = PT.LANGS.map(([c, n]) => `<option value="${c}">${n}</option>`).join('');
  $('lang').value = settings.targetLang;
  $('lang').onchange = () => { settings.targetLang = $('lang').value; save(); };

  /* ---------- 保存（输入停顿 400ms 自动保存） ---------- */
  let timer = 0;
  function scheduleSave() { clearTimeout(timer); timer = setTimeout(save, 400); }
  async function flushSave() { if (timer) { clearTimeout(timer); timer = 0; await save(); } }
  async function save() {
    timer = 0;
    settings = await PT.saveSettings({
      providers: settings.providers, activeProviderId: settings.activeProviderId,
      targetLang: settings.targetLang, uiLang: settings.uiLang,
    });
    $('saved').textContent = t('pop.saved');
    clearTimeout(save.t); save.t = setTimeout(() => { $('saved').textContent = ''; }, 1200);
  }

  /* ---------- 测试 ---------- */
  $('test').onclick = async () => {
    await flushSave();
    const out = $('testOut');
    out.className = ''; out.textContent = t('pop.testing');
    const t0 = performance.now();
    const res = await chrome.runtime.sendMessage({ type: 'translate', cfg: cur(), noCache: true, to: settings.targetLang, segments: ['Hello, world! Both panes scroll together.'] });
    const ms = Math.round(performance.now() - t0);
    if (res && res.error) { out.className = 'err'; out.textContent = t('pop.fail', { ms, text: res.error }); }
    else { out.className = 'ok'; out.textContent = t('pop.ok', { ms, text: (res.results || [])[0] }); }
  };

  $('more').onclick = (e) => { e.preventDefault(); chrome.runtime.openOptionsPage(); };
  function esc(s) { return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }

  renderAll();
  refreshToggle();
})();
