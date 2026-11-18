/* options.js — 完整设置页：通用设置 + 引擎列表（按 type 渲染表单）。修改后点「保存」。 */
(async () => {
  'use strict';
  const PT = globalThis.PT;
  const t = PT.t;
  const $ = (id) => document.getElementById(id);

  // 各引擎类型的表单字段：[key, 标签 i18n key, 输入类型, 占位]
  const FIELDS = {
    openai: [
      ['name', 'f.name', 'text'],
      ['baseUrl', 'f.baseUrlV1', 'text', 'http://127.0.0.1:8000/v1'],
      ['apiKey', 'f.apiKeyOpt', 'password'],
      ['model', 'f.model', 'text', 'Qwen/Qwen3-8B'],
      ['temperature', 'f.temperature', 'text'],
      ['concurrency', 'f.concurrency', 'number'],
      ['batchSize', 'f.batchSize', 'number'],
      ['batchChars', 'f.batchChars', 'number'],
      ['timeoutMs', 'f.timeoutMs', 'number'],
      ['extraBody', 'f.extraBody', 'textarea', '{"chat_template_kwargs": {"enable_thinking": false}}'],
      ['systemPrompt', 'f.systemPrompt', 'textarea'],
    ],
    deepl: [
      ['name', 'f.name', 'text'],
      ['endpoint', 'f.endpoint', 'text', 'https://api-free.deepl.com'],
      ['apiKey', 'f.deeplKey', 'password'],
      ['concurrency', 'f.concurrency', 'number'],
      ['batchSize', 'f.batchSize', 'number'],
      ['batchChars', 'f.batchChars', 'number'],
      ['timeoutMs', 'f.timeoutMs', 'number'],
    ],
    mock: [
      ['name', 'f.name', 'text'],
      ['latencyMs', 'f.latencyMs', 'number'],
    ],
  };

  let settings = await PT.loadSettings();
  const providers = JSON.parse(JSON.stringify(settings.providers || []));

  function fillLangs() {
    const opts = PT.LANGS.map(([c, n]) => `<option value="${c}">${n}</option>`).join('');
    const tv = $('targetLang').value || settings.targetLang, sv = $('sourceLang').value || settings.sourceLang;
    $('targetLang').innerHTML = opts;
    $('sourceLang').innerHTML = `<option value="auto">${t('opt.autoDetect')}</option>` + opts;
    $('targetLang').value = tv; $('sourceLang').value = sv;
  }
  function fillActive() {
    const cur = $('activeProviderId').value || settings.activeProviderId;
    $('activeProviderId').innerHTML = providers.map((p) => `<option value="${p.id}">${esc(PT.provName(p))}</option>`).join('');
    $('activeProviderId').value = providers.some((p) => p.id === cur) ? cur : (providers[0] || {}).id;
  }
  function esc(s) { return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }

  function render() {
    const box = $('providers');
    box.innerHTML = '';
    providers.forEach((p, idx) => {
      const node = $('tpl-provider').content.firstElementChild.cloneNode(true);
      PT.i18n.apply(node);
      node.querySelector('.type').textContent = `${t('type.' + p.type)} · ${p.id}`;
      const fields = node.querySelector('.fields');
      for (const [key, label, type, ph] of FIELDS[p.type] || []) {
        const l = document.createElement('label');
        if (type === 'textarea') l.className = 'wide';
        l.append(t(label));
        const inp = document.createElement(type === 'textarea' ? 'textarea' : 'input');
        if (type !== 'textarea') inp.type = type;
        inp.placeholder = key === 'name' ? PT.provName(Object.assign({}, p, { name: '' })) : (ph || '');
        inp.value = p[key] == null ? '' : p[key];
        inp.oninput = () => {
          p[key] = type === 'number' ? (inp.value === '' ? '' : +inp.value) : inp.value;
          if (key === 'name') fillActive();
        };
        l.append(inp);
        fields.append(l);
      }
      node.querySelector('.del').onclick = () => {
        if (!confirm(t('opt.delConfirm', { name: PT.provName(p) }))) return;
        providers.splice(idx, 1); render(); fillActive();
      };
      const out = node.querySelector('.out');
      node.querySelector('.test').onclick = async () => {
        out.className = 'out'; out.textContent = t('pop.testing');
        const t0 = performance.now();
        const res = await chrome.runtime.sendMessage({
          type: 'translate', cfg: p, noCache: true, to: $('targetLang').value,
          segments: ['Hello, <g1>world</g1>! Press <x2/> to continue.', 'Both panes scroll together, paragraph by paragraph.'],
        });
        const ms = Math.round(performance.now() - t0);
        if (res && res.error) { out.className = 'out err'; out.textContent = t('pop.fail', { ms, text: res.error }); }
        else out.textContent = t('pop.ok', { ms, text: '\n' + (res.results || []).join('\n') });
      };
      box.append(node);
    });
  }

  function addProvider(type) {
    const base = PT.DEFAULTS.providers.find((p) => p.type === type) || { type };
    const id = type + '-' + Math.random().toString(36).slice(2, 7);
    const n = providers.filter((p) => p.type === type).length + 1;
    providers.push(Object.assign({}, base, { id, name: `${t('type.' + type)} ${n}` }));
    render(); fillActive();
  }

  function renderAll() {
    document.documentElement.lang = PT.i18n.lang === 'zh' ? 'zh-CN' : 'en';
    document.title = t('opt.title');
    PT.i18n.apply(document);
    fillLangs(); fillActive(); render(); refreshCache();
  }

  async function refreshCache() {
    const r = await chrome.runtime.sendMessage({ type: 'cache:count' });
    $('cacheInfo').textContent = r && r.n != null ? t('opt.cacheCount', { n: PT.i18n.fmtNum(r.n) }) : t('opt.cacheNA');
  }

  // 界面语言立即生效并保存（其他设置仍需点「保存」）
  $('uiLang').onchange = async () => { settings = await PT.saveSettings({ uiLang: $('uiLang').value }); renderAll(); };
  $('addOpenai').onclick = () => addProvider('openai');
  $('addDeepl').onclick = () => addProvider('deepl');
  $('clearCache').onclick = async () => { await chrome.runtime.sendMessage({ type: 'cache:clear' }); refreshCache(); };
  $('save').onclick = async () => {
    for (const p of providers) {
      if (p.type === 'openai' && p.extraBody && String(p.extraBody).trim()) {
        try { JSON.parse(p.extraBody); } catch (_) { alert(t('opt.extraBodyBad', { name: PT.provName(p) })); return; }
      }
    }
    settings = await PT.saveSettings({
      uiLang: $('uiLang').value,
      sourceLang: $('sourceLang').value,
      targetLang: $('targetLang').value,
      activeProviderId: $('activeProviderId').value,
      highlight: $('highlight').value,
      prefetchScreens: Math.max(0, +$('prefetchScreens').value || 0),
      syncScroll: $('syncScroll').checked,
      stripFrameHeaders: $('stripFrameHeaders').checked,
      providers,
    });
    $('saved').textContent = t('opt.saved');
    setTimeout(() => { $('saved').textContent = ''; }, 1500);
  };

  $('uiLang').value = settings.uiLang || 'auto';
  for (const k of ['highlight', 'prefetchScreens']) $(k).value = settings[k];
  for (const k of ['syncScroll', 'stripFrameHeaders']) $(k).checked = !!settings[k];
  renderAll();
})();
