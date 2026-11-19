/*
 * shell.js — 顶层框架里的"分屏外壳 + 同步协调器"。
 *
 * 打开分屏时：在当前页面上盖一层全屏 UI（closed shadow DOM），放两个同源 iframe
 * 加载同一 URL：左 = 原文，右 = 译文。顶层文档与 iframe 同源，所以 X-Frame-Options:
 * SAMEORIGIN / CSP frame-ancestors 'self' 天然放行、cookie 是第一方的（登录态保留）；
 * 只有 DENY/'none' 需要 SW 用 DNR 临时去掉响应头。
 *
 * 同步：
 *   driver = 最近一次有用户输入的窗格；follower 由 mapper 计算位置。
 *   follower 收到的 scroll 事件按原因处理：prog(自己设的)忽略；layout(译文插入、图片加载
 *   导致的滚动锚定跳动)拉回；user/other 则把驱动权交给它。
 */
(() => {
  'use strict';
  const PT = globalThis.PT;
  const opts = globalThis.__ptShellOpts || {};
  globalThis.__ptShellOpts = null;
  if (globalThis.__ptShell) { globalThis.__ptShell.toggle(opts); return; }

  const S = PT.sync;
  const other = (r) => (r === 'L' ? 'R' : 'L');
  const stripHash = (u) => String(u).split('#')[0];

  class Shell {
    constructor() {
      this.active = false;
      this.onMsg = this.onMsg.bind(this);
    }

    toggle(o) { if (this.active) this.close(); else this.open(o || {}); }

    /* ------------------------------ 打开 ------------------------------ */
    async open(o) {
      if (this.active) return;
      this.active = true;
      this.token = Math.random().toString(36).slice(2, 12);
      this.settings = await PT.loadSettings();
      this.sync = this.settings.syncScroll !== false;
      this.driver = 'L';
      this.lastInput = { L: 0, R: 0 };
      this.state = { L: null, R: null };
      this.anchors = { L: null, R: null };
      this.url = { L: location.href, R: location.href };
      this.navGuard = [];
      this.mapper = null;
      this.lastHover = null;
      this.origUrl = location.href;
      this.origScroll = { x: window.scrollX, y: window.scrollY };
      this.initial = this.readingPointTop(o);

      try { await chrome.runtime.sendMessage({ type: 'split:on' }); } catch (_) { /* SW 不可用时仍尝试 */ }
      this.buildUI();
      window.addEventListener('message', this.onMsg);
      this.onStore = (ch, area) => { if (area === 'local' && ch.settings) this.applySettings(ch.settings.newValue); };
      chrome.storage.onChanged.addListener(this.onStore);
      for (const m of document.querySelectorAll('video,audio')) { try { m.pause(); } catch (_) { /* noop */ } }
    }

    /** 当前视口中正在读的段落（或右键位置的段落），用于左窗格初始定位 */
    readingPointTop(o) {
      try {
        const seg = new PT.Segmenter(document);
        seg.scan(document.body);
        let u = null;
        const ctx = o.fromContext ? globalThis.__ptCtxTarget : null;
        if (ctx && ctx.isConnected) u = seg.unitFromNode(ctx);
        if (u) { const r = seg.rectOf(u); return { k: u.key, off: Math.max(0, r.top) }; }
        let best = null;
        for (const x of seg.units) {
          if (x.fixed || !x.translatable) continue;
          const r = seg.rectOf(x);
          if (!r || r.height === 0 || r.bottom <= 4) continue;
          if (!best || r.top < best.top) best = { u: x, top: r.top };
        }
        if (best && window.scrollY > 0) return { k: best.u.key, off: Math.max(0, best.top) };
      } catch (e) { console.warn('[Duet-Translator] reading point failed', e); }
      return null;
    }

    buildUI() {
      const host = document.createElement('pt-split-root');
      host.style.cssText = 'all:initial;position:fixed;inset:0;z-index:2147483647;display:block;';
      const sr = host.attachShadow({ mode: 'open' });   // open 便于调试/测试；页面 CSS 依然无法穿透
      const langOpts = PT.LANGS.map(([c, n]) => `<option value="${c}">${n}</option>`).join('');
      const provOpts = provOptions(this.settings);
      sr.innerHTML = `
<style>
  :host { all: initial; }
  .wrap { position: absolute; inset: 0; display: flex; flex-direction: column; background: #fff;
    font: 13px/1.4 system-ui, -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif; color: #1f2937; }
  .bar { height: 38px; flex: none; display: flex; align-items: center; gap: 10px; padding: 0 10px;
    border-bottom: 1px solid #e5e7eb; background: #f8fafc; }
  .brand { font-weight: 600; white-space: nowrap; display: inline-flex; align-items: center; gap: 6px; }
  .brand svg { width: 18px; height: 18px; flex: none; }
  .status { color: #6b7280; min-width: 120px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; flex: 1; }
  .status.err { color: #b91c1c; }
  .meter { flex: none; display: inline-flex; align-items: center; gap: 6px; height: 22px; padding: 0 8px; border-radius: 11px;
    background: #ecfdf5; color: #047857; font-variant-numeric: tabular-nums; white-space: nowrap; cursor: default; font-size: 12px; }
  .meter[hidden] { display: none; }
  .meter b { font-weight: 600; }
  .meter .sep { width: 1px; height: 12px; background: #a7f3d0; }
  .busy { flex: none; width: 10px; height: 10px; border-radius: 50%; border: 2px solid #93c5fd; border-top-color: #2563eb; animation: spin .8s linear infinite; }
  .busy[hidden] { display: none; }
  @keyframes spin { to { transform: rotate(360deg); } }
  button.warn { background: #fef3c7; border-color: #f59e0b; color: #92400e; font-weight: 600; }
  select, button { font: inherit; height: 26px; border: 1px solid #d1d5db; border-radius: 6px; background: #fff; padding: 0 8px; color: inherit; }
  button { cursor: pointer; } button:hover { background: #f3f4f6; }
  label { display: inline-flex; align-items: center; gap: 4px; white-space: nowrap; cursor: pointer; }
  .panes { flex: 1; display: flex; min-height: 0; }
  iframe { flex: 1 1 0; min-width: 120px; border: 0; height: 100%; background: #fff; }
  .divider { flex: none; width: 6px; cursor: col-resize; background: #e5e7eb; }
  .divider:hover, .divider.drag { background: #93c5fd; }
  .dragmask { position: absolute; inset: 0; display: none; cursor: col-resize; }
</style>
<div class="wrap">
  <div class="bar">
    <span class="brand">${LOGO_SVG}<span data-i18n="brand"></span></span>
    <span class="busy" id="busy" hidden></span>
    <span class="status" id="status" data-i18n="sh.loading"></span>
    <span class="meter" id="meter" hidden></span>
    <button id="setkey" class="warn" data-i18n="sh.setKey" hidden></button>
    <select id="lang" data-i18n-title="sh.lang.title">${langOpts}</select>
    <select id="prov" data-i18n-title="sh.prov.title">${provOpts}</select>
    <label data-i18n-title="sh.sync.title"><input type="checkbox" id="sync"> <span data-i18n="sh.sync"></span></label>
    <select id="hl" data-i18n-title="sh.hl.title"><option value="hover" data-i18n="hl.hover"></option><option value="off" data-i18n="hl.off"></option></select>
    <button id="all" data-i18n-title="sh.all.title" data-i18n="sh.all"></button>
    <button id="retry" data-i18n-title="sh.retry.title" data-i18n="sh.retry" hidden></button>
    <button id="redo" data-i18n-title="sh.redo.title">↻</button>
    <button id="swap" data-i18n-title="sh.swap.title">⇆</button>
    <button id="opts" data-i18n-title="sh.opts.title">⚙</button>
    <button id="close" data-i18n-title="sh.close.title">✕</button>
  </div>
  <div class="panes" id="panes">
    <iframe id="L"></iframe>
    <div class="divider" id="div"></div>
    <iframe id="R"></iframe>
  </div>
  <div class="dragmask" id="mask"></div>
</div>`;
      PT.i18n.apply(sr);
      this.sr = sr;
      const $ = (id) => sr.getElementById(id);
      this.$ = $;
      this.frames = { L: $('L'), R: $('R') };
      for (const r of ['L', 'R']) {
        const f = this.frames[r];
        f.name = `__pt:${r}:${this.token}`;
        // 不给 allow-top-navigation：页面的防嵌套脚本(frame-busting)无法把整个标签页跳走
        f.setAttribute('sandbox', 'allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox allow-modals allow-downloads allow-pointer-lock');
        f.setAttribute('allow', 'fullscreen; clipboard-read; clipboard-write; autoplay');
        f.src = location.href;
      }
      $('lang').value = this.settings.targetLang;
      $('prov').value = this.settings.activeProviderId;
      $('sync').checked = this.sync;
      $('hl').value = this.settings.highlight || 'hover';

      $('close').onclick = () => this.close();
      $('swap').onclick = () => {
        const swapped = $('L').style.order === '3';
        $('L').style.order = swapped ? '' : '3';
        $('div').style.order = swapped ? '' : '2';
        $('R').style.order = swapped ? '' : '1';
      };
      $('sync').onchange = (e) => {
        this.sync = e.target.checked;
        PT.saveSettings({ syncScroll: this.sync });
        if (this.sync) this.syncFollower();
      };
      $('hl').onchange = (e) => PT.saveSettings({ highlight: e.target.value });
      // 语言 / 引擎变化统一由 onStore 处理（弹窗、设置页里改也一样生效）
      $('lang').onchange = (e) => PT.saveSettings({ targetLang: e.target.value });
      $('prov').onchange = (e) => PT.saveSettings({ activeProviderId: e.target.value });
      $('all').onclick = () => {
        const st = this.lastStatus || {};
        const msg = PT.t('sh.confirmAll', { n: st.leftN ?? '?', chars: PT.i18n.fmtNum(st.leftChars) });
        if (window.confirm(msg)) this.send('R', 'translateAll', {});
      };
      $('retry').onclick = () => this.send('R', 'retry', {});
      // 重新翻译本页：只清掉本页写入的缓存条目，再重新加载右窗格
      $('redo').onclick = async () => {
        if (!window.confirm(PT.t('sh.redo.confirm'))) return;
        try { await chrome.runtime.sendMessage({ type: 'cache:clear', scope: { page: this.url.R || this.url.L || location.href } }); } catch (_) { /* noop */ }
        this.reloadR();
      };
      $('setkey').onclick = () => chrome.runtime.sendMessage({ type: 'openWelcome' });
      $('opts').onclick = () => chrome.runtime.sendMessage({ type: 'openOptions' });

      // 拖动分隔条
      const div = $('div'), mask = $('mask'), panes = $('panes');
      div.addEventListener('pointerdown', (e) => {
        e.preventDefault();
        div.classList.add('drag'); mask.style.display = 'block';
        const rect = panes.getBoundingClientRect();
        const leftFirst = $('L').style.order !== '3';
        const move = (ev) => {
          const ratio = Math.min(0.85, Math.max(0.15, (ev.clientX - rect.left) / rect.width));
          $(leftFirst ? 'L' : 'R').style.flex = `${ratio} 1 0`;
          $(leftFirst ? 'R' : 'L').style.flex = `${1 - ratio} 1 0`;
        };
        const up = () => {
          div.classList.remove('drag'); mask.style.display = 'none';
          window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up);
        };
        window.addEventListener('pointermove', move);
        window.addEventListener('pointerup', up);
      });

      this.style = document.createElement('style');
      this.style.textContent = 'html.__pt-on{overflow:hidden!important}html.__pt-on>body{display:none!important}';
      document.documentElement.appendChild(this.style);
      document.documentElement.classList.add('__pt-on');
      document.documentElement.appendChild(host);
      this.host = host;
    }

    /** 设置在别处（弹窗 / 设置页 / 顶栏）被修改：同步顶栏，必要时重翻 */
    applySettings(raw) {
      if (!this.active) return;
      const nv = Object.assign({}, PT.DEFAULTS, raw || {});
      const old = this.settings;
      this.settings = nv;
      const $ = this.$;
      if (PT.i18n.setLang(nv.uiLang) !== PT.i18n.resolve(old.uiLang)) {   // 界面语言切换
        PT.i18n.apply(this.sr);
        if (this.lastStatus) this.onStatus(this.lastStatus);
      }
      $('prov').innerHTML = provOptions(nv);
      $('prov').value = nv.activeProviderId;
      $('lang').value = nv.targetLang;
      $('hl').value = nv.highlight || 'hover';
      this.sync = nv.syncScroll !== false;
      $('sync').checked = this.sync;
      if (nv.targetLang !== old.targetLang || nv.activeProviderId !== old.activeProviderId) { this.reloadR(); return; }
      const find = (s) => JSON.stringify((s.providers || []).find((p) => p.id === s.activeProviderId) || null);
      if (find(nv) !== find(old)) this.send('R', 'retry', {});   // 例如刚填了 API Key：重试失败的段落
    }

    reloadR() {
      this.anchors.R = null; this.state.R = null; this.mapper = null;
      this.frames.R.src = this.url.R || this.url.L;
      this.setStatus(PT.t('sh.reloading'));
    }

    send(to, type, data) {
      const f = this.frames && this.frames[to];
      if (!f || !f.contentWindow) return;
      f.contentWindow.postMessage(Object.assign({ __pt: this.token, to, type }, data), '*');
    }

    setStatus(text, err) {
      const el = this.$ && this.$('status');
      if (!el) return;
      el.textContent = text;
      el.classList.toggle('err', !!err);
      el.title = text;
    }

    /* ------------------------------ 消息 ------------------------------ */
    onMsg(e) {
      const d = e.data;
      if (!d || d.__pt !== this.token) return;
      const from = d.from;
      if (from !== 'L' && from !== 'R') return;
      if (e.source !== (this.frames[from] && this.frames[from].contentWindow)) return;
      switch (d.type) {
        case 'hello': return this.onHello(from, d);
        case 'anchors': return this.onAnchors(from, d);
        case 'scroll': return this.onScroll(from, d);
        case 'input': this.lastInput[from] = performance.now(); this.driver = from; return;
        case 'hover':
          if ((this.settings.highlight || 'hover') !== 'off') this.send(other(from), 'highlight', { k: d.k });
          return;
        case 'status': return this.onStatus(d);
        case 'nav': return this.onNav(from, d.url);
        case 'reading': if (this.readingResolve) this.readingResolve(d); return;
        default:
      }
    }

    onHello(from, d) {
      this.challenge = this.challenge || {};
      this.challenge[from] = !!d.challenge;
      if (d.challenge) this.setStatus(PT.t('sh.blocked'), true);
      this.state[from] = d.s;
      this.anchors[from] = null;
      this.mapper = null;
      this.send(from, 'init', { initial: from === 'L' ? this.initial : null });
      if (from === 'L') this.initial = null;
      this.onNav(from, d.url);
    }

    /** 一侧换了页面（点链接 / SPA 路由），另一侧跟上 */
    onNav(from, url) {
      const prev = this.url[from];
      this.url[from] = url;
      const to = other(from);
      if (stripHash(this.url[to]) === stripHash(url)) return;
      if (stripHash(prev) === stripHash(url)) return;       // 本侧没换页，是另一侧在换
      const t = Date.now();
      this.navGuard = this.navGuard.filter((x) => t - x < 4000);
      if (this.navGuard.length >= 3) return;     // 防止重定向不一致导致来回跳
      this.navGuard.push(t);
      this.url[to] = url;
      this.anchors[to] = null; this.state[to] = null; this.mapper = null;
      this.frames[to].src = url;
      try {
        if (new URL(url).origin === location.origin) history.replaceState(history.state, '', url);
      } catch (_) { /* noop */ }
    }

    onAnchors(from, d) {
      this.anchors[from] = d.anchors;
      this.state[from] = d.s;
      this.rebuildMapper();
      this.syncFollower();
    }

    rebuildMapper() {
      const A = this.anchors.L, B = this.anchors.R;
      const sL = this.state.L, sR = this.state.R;
      if (!A || !B || !sL || !sR) { this.mapper = null; return; }
      const pts = S.buildPairs(A, B, { HA: sL.H, HB: sR.H });
      this.mapper = S.createMapper(pts);
      this.mapper.matched = pts.length - 2;
    }

    onScroll(from, d) {
      this.state[from] = d.s;
      if (!this.sync) return;
      if (from === this.driver) return this.syncFollower();
      // 只有"最近一次输入"发生在本侧，才把驱动权交给它
      if ((d.cause === 'user' && this.lastInput[from] >= this.lastInput[this.driver]) || d.cause === 'other') {
        this.driver = from;
        return this.syncFollower();
      }
      if (d.cause === 'layout') return this.syncFollower();
      // 'prog'：自己设置的位置，忽略
    }

    syncFollower() {
      if (!this.sync || !this.mapper) return;
      const D = this.driver, F = other(D);
      const sd = this.state[D], sf = this.state[F];
      if (!sd || !sf) return;
      const map = D === 'L' ? this.mapper.LtoR : this.mapper.RtoL;
      const t = S.followerScrollTop(sd, sf, map);
      if (Math.abs(t - sf.t) < 0.5) return;
      sf.t = t;
      this.send(F, 'scrollTo', { t });
    }

    onStatus(d) {
      this.lastStatus = d;
      const retry = this.$('retry');
      const keyIssue = d.errCode === 'noKey' || d.errCode === 'badKey';
      retry.hidden = !d.err || keyIssue;
      this.$('setkey').hidden = !keyIssue;   // 没填 / 填错 Key：直接给入口
      this.$('busy').hidden = !d.inflight;
      const f = PT.i18n.fmtNum;
      let txt = PT.t('sh.status', { lang: PT.langName(this.settings.targetLang), done: d.done, total: d.total, sent: f(d.sent) });
      this.renderMeter(d);
      if (d.inflight) txt += PT.t('sh.inflight', { n: d.inflight });
      if (d.err) txt += PT.t('sh.failed', { n: d.err });
      if (d.error) txt += ` · ${d.error}`;
      const blocked = this.challenge && (this.challenge.L || this.challenge.R);
      if (blocked) txt = PT.t('sh.blocked') + ' · ' + txt;
      this.setStatus(txt, !!d.error || blocked);
      const el = this.$('status');
      el.title = txt + '\n' + PT.t('sh.tip', { n: d.leftN, chars: f(d.leftChars), c: d.cancelled }) +
        (this.mapper ? PT.t('sh.anchors', { n: this.mapper.matched }) : '');
    }

    /** 用量徽章：本页 token（命中服务端前缀缓存的比例）、本地缓存命中段数、估算费用 */
    renderMeter(d) {
      const el = this.$('meter');
      const u = d.usage || {};
      const tok = (u.inTok || 0) + (u.outTok || 0);
      if (!tok && !d.cacheHits) { el.hidden = true; return; }
      const f = PT.i18n.fmtNum;
      const k = (n) => (n >= 10000 ? (n / 1000).toFixed(0) + 'k' : n >= 1000 ? (n / 1000).toFixed(1) + 'k' : String(n));
      const cfg = (this.settings.providers || []).find((p) => p.id === this.settings.activeProviderId) || {};
      const priced = cfg.priceIn > 0 || cfg.priceOut > 0;
      const miss = Math.max(0, (u.inTok || 0) - (u.cachedTok || 0));
      const cost = ((miss * (+cfg.priceIn || 0)) + (u.cachedTok || 0) * (+cfg.priceCached || 0) + (u.outTok || 0) * (+cfg.priceOut || 0)) / 1e6;
      const money = cost === 0 ? '$0' : cost < 0.001 ? '<$0.001' : '$' + cost.toFixed(cost < 0.1 ? 3 : 2);
      const hitPct = u.inTok ? Math.round((u.cachedTok || 0) / u.inTok * 100) : 0;
      const parts = [];
      if (tok) parts.push(`<span>${PT.t('sh.meter.tok', { n: '<b>' + k(tok) + '</b>' })}</span>`);
      if (d.cacheHits) parts.push(`<span>${PT.t('sh.meter.hits', { n: '<b>' + f(d.cacheHits) + '</b>' })}</span>`);
      if (priced && tok) parts.push(`<span><b>${money}</b></span>`);
      el.innerHTML = parts.join('<span class="sep"></span>');
      el.title = PT.t('sh.meter.tip', {
        req: f(u.req || 0), inTok: f(u.inTok || 0), hit: hitPct, outTok: f(u.outTok || 0),
        hits: f(d.cacheHits || 0), dedup: f(d.dedup || 0), sent: f(d.sent || 0), c: f(d.cancelled || 0),
      }) + (priced ? '\n' + PT.t('sh.meter.cost', { money }) : '') + (u.est ? '\n' + PT.t('sh.meter.est') : '');
      el.hidden = false;
    }

    /* ------------------------------ 关闭 ------------------------------ */
    async close() {
      if (!this.active) return;
      // 问左窗格当前读到哪一段，关闭后原页面停在同一段
      const reading = await new Promise((resolve) => {
        this.readingResolve = resolve;
        this.send('L', 'readingReq', {});
        setTimeout(() => resolve(null), 300);
      });
      this.readingResolve = null;
      window.removeEventListener('message', this.onMsg);
      chrome.storage.onChanged.removeListener(this.onStore);
      this.host.remove();
      this.style.remove();
      document.documentElement.classList.remove('__pt-on');
      this.active = false;
      this.frames = null;
      try { await chrome.runtime.sendMessage({ type: 'split:off' }); } catch (_) { /* noop */ }

      const paneUrl = (reading && reading.url) || this.url.L;
      if (stripHash(paneUrl) !== stripHash(this.origUrl)) { location.assign(paneUrl); return; }
      window.scrollTo(this.origScroll.x, this.origScroll.y);
      if (reading && reading.p) {
        const seg = new PT.Segmenter(document);
        seg.scan(document.body);
        const u = seg.byKey.get(reading.p.k);
        const r = u && seg.rectOf(u);
        if (r) window.scrollTo({ top: window.scrollY + r.top - reading.p.off, behavior: 'instant' });
      }
    }
  }

  // 顶栏 logo（与 icons/logo-small.svg 相同，内联以免把扩展资源暴露给网页）
  const LOGO_SVG = '<svg viewBox="0 0 16 16" aria-hidden="true"><rect width="16" height="16" rx="3.5" fill="#2563eb"/>' +
    '<rect x="2" y="2.5" width="5.5" height="11" rx="1.2" fill="#fff"/><rect x="8.5" y="2.5" width="5.5" height="11" rx="1.2" fill="#dbeafe"/>' +
    '<rect x="1" y="6.5" width="14" height="3" rx="1" fill="#fbbf24"/></svg>';

  function provOptions(s) {
    return (s.providers || []).map((p) => `<option value="${p.id}">${escapeHtml(PT.provName(p))}</option>`).join('');
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  const shell = new Shell();
  globalThis.__ptShell = shell;
  shell.open(opts);
})();
