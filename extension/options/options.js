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
      ['maxTokens', 'f.maxTokens', 'number', 'auto'],
      ['contextTokens', 'f.contextTokens', 'number'],
      ['priceIn', 'f.priceIn', 'number'],
      ['priceCached', 'f.priceCached', 'number'],
      ['priceOut', 'f.priceOut', 'number'],
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
  const removedPresets = new Set(settings.removedPresets || []);

  function fillLangs() {
    const opts = PT.LANGS.map(([c, n]) => `<option value="${c}">${n}</option>`).join('');
    const tv = $('targetLang').value || settings.targetLang, sv = $('sourceLang').value || settings.sourceLang;
    $('targetLang').innerHTML = opts;
    $('sourceLang').innerHTML = `<option value="auto">${t('opt.autoDetect')}</option>` + opts;
    $('targetLang').value = tv; $('sourceLang').value = sv;
  }
  // Mock 演示引擎只在开发者选项打开时显示（或它正是当前引擎）
  const shown = () => providers.filter((p) => p.type !== 'mock' || $('devMode').checked || p.id === $('activeProviderId').value);
  function fillActive() {
    const cur = $('activeProviderId').value || settings.activeProviderId;
    $('activeProviderId').innerHTML = shown().map((p) => `<option value="${p.id}">${esc(PT.provName(p))}</option>`).join('');
    $('activeProviderId').value = shown().some((p) => p.id === cur) ? cur : (shown()[0] || {}).id;
  }
  function esc(s) { return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }

  function render() {
    const box = $('providers');
    box.innerHTML = '';
    providers.forEach((p, idx) => {
      if (!shown().includes(p)) return;
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
          let v = inp.value;
          // Key / 地址去掉首尾空格；Key 顺手去掉误粘贴的 "Bearer " 前缀
          if (key === 'apiKey') v = v.trim().replace(/^Bearer\s+/i, '');
          else if (key === 'baseUrl' || key === 'endpoint') v = v.trim();
          p[key] = type === 'number' ? (v === '' ? '' : +v) : v;
          if (key === 'name') fillActive();
        };
        l.append(inp);
        fields.append(l);
      }
      node.querySelector('.del').onclick = () => {
        if (!confirm(t('opt.delConfirm', { name: PT.provName(p) }))) return;
        if (PT.DEFAULTS.providers.some((d) => d.id === p.id)) removedPresets.add(p.id);   // 删掉的预设以后不再自动加回
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
    fillLangs(); fillActive(); render(); refreshCache(); refreshUsage();
  }

  const fmt = (n) => PT.i18n.fmtNum(Math.round(n || 0));
  const mb = (b) => (b == null ? '—' : (b / 1048576).toFixed(b < 1048576 ? 2 : 1) + ' MB');
  function costOf(p, u) {
    if (!p || !(p.priceIn > 0 || p.priceOut > 0)) return null;
    const miss = Math.max(0, u.inTok - u.cachedTok);
    return (miss * (+p.priceIn || 0) + u.cachedTok * (+p.priceCached || 0) + u.outTok * (+p.priceOut || 0)) / 1e6;
  }
  const money = (c) => (c == null ? '—' : c < 0.01 ? '$' + c.toFixed(4) : '$' + c.toFixed(2));

  async function refreshCache() {
    const r = await chrome.runtime.sendMessage({ type: 'cache:info' });
    if (!r || r.error) { $('cacheStats').textContent = t('opt.cacheNA'); return; }
    const hitRate = r.hits + r.misses ? Math.round(r.hits / (r.hits + r.misses) * 100) + '%' : '—';
    const stat = (v, label, cls) => `<div class="stat ${cls || ''}"><b>${v}</b><span>${label}</span></div>`;
    $('cacheStats').innerHTML =
      stat(fmt(r.count), t('opt.st.entries')) +
      stat(mb(r.bytes), t('opt.st.size', { max: r.limits.maxMB })) +
      stat(hitRate, t('opt.st.hitRate'), 'good') +
      stat(fmt(r.savedChars), t('opt.st.saved'), 'good');
    const lp = r.lastPrune;
    $('cacheInfo').textContent = lp ? t('opt.lastPrune', { e: fmt(lp.expired), v: fmt(lp.evicted), s: fmt(lp.spared) }) : '';
  }

  async function refreshUsage() {
    const u = await chrome.runtime.sendMessage({ type: 'usage:get' });
    const rows = Object.entries(u || {}).filter(([, x]) => x && x.req);
    if (!rows.length) { $('usageTable').innerHTML = `<p class="muted">${t('opt.usage.none')}</p>`; return; }
    const head = ['opt.u.engine', 'opt.u.req', 'opt.u.in', 'opt.u.hit', 'opt.u.out', 'opt.u.cost'].map((k) => `<th>${t(k)}</th>`).join('');
    const body = rows.map(([id, x]) => {
      const p = providers.find((q) => q.id === id);
      const hit = x.inTok ? Math.round(x.cachedTok / x.inTok * 100) + '%' : '—';
      return `<tr><td>${esc(p ? PT.provName(p) : id)}</td><td>${fmt(x.req)}</td><td>${fmt(x.inTok)}</td><td>${hit}</td><td>${fmt(x.outTok)}</td><td>${money(costOf(p, x))}</td></tr>`;
    }).join('');
    $('usageTable').innerHTML = `<table class="usage"><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>`;
  }

  // 界面语言立即生效并保存（其他设置仍需点「保存」）
  $('uiLang').onchange = async () => { settings = await PT.saveSettings({ uiLang: $('uiLang').value }); renderAll(); };
  $('addOpenai').onclick = () => addProvider('openai');
  $('addDeepl').onclick = () => addProvider('deepl');
  $('clearCache').onclick = async () => {
    if (!confirm(t('opt.clearCache.confirm'))) return;
    await chrome.runtime.sendMessage({ type: 'cache:clear' }); refreshCache();
  };
  // 只清当前引擎（换模型 / 改了提示词后想全部重翻时用）
  $('clearEngineCache').onclick = async () => {
    const p = providers.find((q) => q.id === $('activeProviderId').value);
    if (!p) return;
    const r = await chrome.runtime.sendMessage({ type: 'cache:clear', scope: { nsPrefix: p.type + '|' + p.id + '|' } });
    $('cacheInfo').textContent = t('opt.cleared', { n: fmt(r && r.removed), name: PT.provName(p) });
    setTimeout(refreshCache, 1200);
  };
  $('pruneCache').onclick = async () => { await chrome.runtime.sendMessage({ type: 'cache:prune' }); refreshCache(); };
  $('resetUsage').onclick = async () => { await chrome.runtime.sendMessage({ type: 'usage:reset' }); refreshUsage(); };
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
      cacheMaxMB: Math.max(1, +$('cacheMaxMB').value || PT.DEFAULTS.cacheMaxMB),
      cacheTTLDays: Math.max(1, +$('cacheTTLDays').value || PT.DEFAULTS.cacheTTLDays),
      syncScroll: $('syncScroll').checked,
      stripFrameHeaders: $('stripFrameHeaders').checked,
      devMode: $('devMode').checked,
      removedPresets: [...removedPresets],
      providers,
    });
    $('saved').textContent = t('opt.saved');
    setTimeout(() => { $('saved').textContent = ''; }, 1500);
  };

  $('uiLang').value = settings.uiLang || 'auto';
  for (const k of ['highlight', 'prefetchScreens', 'cacheMaxMB', 'cacheTTLDays']) $(k).value = settings[k];
  for (const k of ['syncScroll', 'stripFrameHeaders', 'devMode']) $(k).checked = !!settings[k];
  $('devMode').onchange = () => { fillActive(); render(); };
  renderAll();
})();
