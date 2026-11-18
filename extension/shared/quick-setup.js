/*
 * quick-setup.js — 弹窗与引导页共用的快速设置：选引擎、填 Key / 地址 / 模型、目标语言、测试连接。修改即自动保存。
 * 页面里需要有这些元素：#engine #fields #lang #test #testOut（可选 #saved）。
 */
(function (root) {
  'use strict';
  const PT = root.PT;
  // 每种引擎在快速设置里显示的字段：[key, 标签, 类型, 占位]（其余参数在「更多设置」）
  const QUICK = {
    openai: [['apiKey', 'f.apiKey', 'password', 'f.apiKey.ph'], ['baseUrl', 'f.baseUrl', 'text', 'f.baseUrl.ph'], ['model', 'f.model', 'text', '']],
    deepl: [['apiKey', 'f.deeplKey', 'password', ''], ['endpoint', 'f.endpoint', 'text', 'f.endpoint.ph']],
    mock: [],
  };
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  root.PT.mountQuickSetup = async function (doc, opts) {
    opts = opts || {};
    const t = PT.t;
    const $ = (id) => doc.getElementById(id);
    let settings = await PT.loadSettings();
    const cur = () => settings.providers.find((p) => p.id === settings.activeProviderId) || settings.providers[0];
    // Mock 只在开发者选项打开时出现（或它正是当前引擎）
    const visible = () => settings.providers.filter((p) => p.type !== 'mock' || settings.devMode || p.id === settings.activeProviderId);

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
      const sv = $('saved');
      if (sv) {
        sv.textContent = t('pop.saved');
        clearTimeout(save.t); save.t = setTimeout(() => { sv.textContent = ''; }, 1200);
      }
      if (opts.onChange) opts.onChange(settings);
    }

    /* ---------- 渲染 ---------- */
    function keyHint(strong) {
      const h = $('keyHint');
      if (!h) return;
      const p = cur();
      const missing = PT.needsKey(p) && !PT.hasKey(p);
      h.hidden = !missing;
      h.textContent = missing ? t(strong ? 'pop.needKey' : 'pop.needKeyHint') : '';
      h.className = 'keyhint' + (strong ? ' warn' : '');
      const inp = $('f-apiKey');
      if (inp) inp.classList.toggle('warn', !!(strong && missing));
    }
    function render() {
      $('engine').innerHTML = visible().map((p) => `<option value="${p.id}">${esc(PT.provName(p))}</option>`).join('');
      $('engine').value = cur().id;
      $('lang').innerHTML = PT.LANGS.map(([c, n]) => `<option value="${c}">${n}</option>`).join('');
      $('lang').value = settings.targetLang;
      const p = cur();
      const box = $('fields');
      box.innerHTML = '';
      if (p.type === 'mock') {
        const n = doc.createElement('div'); n.className = 'note'; n.textContent = t('pop.mockNote'); box.append(n);
      }
      for (const [key, label, type, ph] of QUICK[p.type] || []) {
        const l = doc.createElement('label');
        l.append(t(label));
        const inp = doc.createElement('input');
        inp.type = type; inp.placeholder = ph ? t(ph) : ''; inp.value = p[key] || ''; inp.id = 'f-' + key;
        inp.spellcheck = false; inp.autocomplete = 'off';
        inp.oninput = () => { p[key] = inp.value.trim(); keyHint(false); scheduleSave(); };
        if (type === 'password') {
          const row = doc.createElement('div'); row.className = 'keyrow';
          const eye = doc.createElement('button'); eye.type = 'button'; eye.textContent = t('pop.show');
          eye.onclick = () => { inp.type = inp.type === 'password' ? 'text' : 'password'; eye.textContent = t(inp.type === 'password' ? 'pop.show' : 'pop.hide'); };
          row.append(inp, eye); l.append(row);
          const hint = doc.createElement('div'); hint.id = 'keyHint'; hint.hidden = true; l.append(hint);
        } else l.append(inp);
        box.append(l);
      }
      keyHint(false);
      $('testOut').textContent = ''; $('testOut').className = '';
    }

    $('engine').onchange = async () => { await flushSave(); settings.activeProviderId = $('engine').value; await save(); render(); };
    $('lang').onchange = () => { settings.targetLang = $('lang').value; save(); };
    $('test').onclick = async () => {
      await flushSave();
      const out = $('testOut');
      if (!ready()) { demandKey(); out.className = 'err'; out.textContent = t('pop.needKey'); return; }
      out.className = ''; out.textContent = t('pop.testing');
      const t0 = performance.now();
      const res = await chrome.runtime.sendMessage({ type: 'translate', cfg: cur(), noCache: true, to: settings.targetLang, segments: ['Hello, world! Both panes scroll together.'] });
      const ms = Math.round(performance.now() - t0);
      if (res && res.error) { out.className = 'err'; out.textContent = t('pop.fail', { ms, text: res.error }); }
      else { out.className = 'ok'; out.textContent = t('pop.ok', { ms, text: (res.results || [])[0] }); }
    };

    /** 当前引擎能否直接用（不需要 Key，或已填 Key） */
    function ready() { const p = cur(); return !PT.needsKey(p) || PT.hasKey(p); }
    /** 用户要开始但没填 Key：醒目提示并聚焦输入框 */
    function demandKey() { keyHint(true); const inp = $('f-apiKey'); if (inp) inp.focus(); }
    async function setUiLang(l) { await flushSave(); settings.uiLang = l; await save(); }

    render();
    return { render, flushSave, ready, demandKey, setUiLang, get settings() { return settings; } };
  };
})(globalThis);
