/*
 * pane.js — 窗格代理。由 SW 注入到分屏的两个 iframe 中（window.name = "__pt:L|R:<token>"）。
 *
 * 职责
 *   1. 识别主滚动容器（window 或页面内部的大滚动 div）
 *   2. 切分段落，计算锚点 {k,t,b}（内容坐标），布局变化时节流上报
 *   3. 上报滚动状态 + 滚动原因(user/prog/layout/other)；执行 shell 下发的 scrollTo
 *   4. 悬停高亮：本窗格画框，并让另一窗格高亮同 key 段落
 *   5. (仅 R) 视口优先的分批翻译、回填、页面重渲染后的重译
 */
(() => {
  'use strict';
  const m = /^__pt:([LR]):([a-z0-9]+)$/.exec(window.name || '');
  if (!m || window.top === window || window.__ptPaneAgent) return;
  window.__ptPaneAgent = true;

  const ROLE = m[1];
  const TOKEN = m[2];
  const PT = globalThis.PT;
  const doc = document;
  const now = () => performance.now();

  let settings = null;
  const seg = new PT.Segmenter(doc);

  /* ------------------------------ 消息 ------------------------------ */
  function post(type, data) {
    try { window.parent.postMessage(Object.assign({ __pt: TOKEN, from: ROLE, type }, data), '*'); } catch (_) { /* noop */ }
  }
  const handlers = {};
  window.addEventListener('message', (e) => {
    if (e.source !== window.parent) return;
    const d = e.data;
    if (!d || d.__pt !== TOKEN || d.to !== ROLE) return;
    const h = handlers[d.type];
    if (h) h(d);
  });

  /* ---------------------------- 滚动容器 ---------------------------- */
  let scroller = null;   // null = window
  function detectScroller() {
    const se = doc.scrollingElement || doc.documentElement;
    if (se.scrollHeight - se.clientHeight > 40) return null;
    let best = null, bestScore = 0;
    const vw = window.innerWidth, vh = window.innerHeight;
    for (const el of doc.body ? doc.body.querySelectorAll('*') : []) {
      if (el.scrollHeight - el.clientHeight < 40) continue;
      if (el.clientHeight < vh * 0.4 || el.clientWidth < vw * 0.4) continue;
      const oy = getComputedStyle(el).overflowY;
      if (oy !== 'auto' && oy !== 'scroll' && oy !== 'overlay') continue;
      const score = el.clientWidth * el.clientHeight;
      if (score > bestScore) { best = el; bestScore = score; }
    }
    return best;
  }
  function sstate() {
    if (scroller && scroller.isConnected) return { t: scroller.scrollTop, vh: scroller.clientHeight, H: scroller.scrollHeight };
    const se = doc.scrollingElement || doc.documentElement;
    return { t: window.scrollY, vh: se.clientHeight, H: se.scrollHeight };
  }
  /** 内容坐标原点在视口中的 y */
  function originY() {
    if (scroller && scroller.isConnected) return scroller.getBoundingClientRect().top + scroller.clientTop - scroller.scrollTop;
    return -window.scrollY;
  }
  function viewportTop() {
    return scroller && scroller.isConnected ? scroller.getBoundingClientRect().top + scroller.clientTop : 0;
  }
  let expect = null;   // 程序设置的滚动位置，用于识别"自己引起的 scroll 事件"
  function setScroll(t) {
    expect = { t, until: now() + 600 };
    const opt = { top: t, behavior: 'instant' };
    if (scroller && scroller.isConnected) scroller.scrollTo(opt); else window.scrollTo(opt);
  }

  /* ----------------------------- 锚点 ----------------------------- */
  let lastLayoutTs = 0;
  let lastSig = '';
  function computeAnchors() {
    seg.prune();
    const o = originY();
    const out = [];
    const vw = doc.documentElement.clientWidth;
    for (const u of seg.units) {
      u.y = NaN;
      if (scroller && !scroller.contains(u.parent)) continue;
      const r = seg.rectOf(u);
      if (!r || r.width < 1 || r.height < 1) continue;
      // 折叠菜单、语言列表等"有布局但看不见"的元素：不做锚点、暂不翻译（展开后会重新测量）
      if (r.right <= 0 || r.left >= vw) continue;
      const host = u.el || u.parent;
      if (host.checkVisibility && !host.checkVisibility({ opacityProperty: true, visibilityProperty: true })) continue;
      if (u.fixed) { u.y = r.top - o; u.vy = r.top - viewportTop(); u.h = r.height; continue; }   // 固定元素不做锚点
      u.y = r.top - o; u.h = r.height;
      out.push({ k: u.key, t: Math.round(u.y * 10) / 10, b: Math.round((u.y + u.h) * 10) / 10 });
    }
    return out;
  }
  let anchorTimer = 0, anchorPending = false, lastAnchorTs = 0;
  function scheduleAnchors(force) {
    if (force) lastSig = '';
    if (anchorPending) return;
    anchorPending = true;
    const wait = Math.max(0, 120 - (now() - lastAnchorTs));
    clearTimeout(anchorTimer);
    anchorTimer = setTimeout(() => {
      anchorPending = false;
      lastAnchorTs = now();
      const anchors = computeAnchors();
      const s = sstate();
      let sum = 0;
      for (const a of anchors) sum += a.t;
      const sig = anchors.length + ':' + Math.round(sum) + ':' + s.H + ':' + s.vh;
      if (sig !== lastSig) {
        lastSig = sig;
        post('anchors', { anchors, s });
      }
      if (ROLE === 'R') pump();
      refreshHighlight();
    }, wait);
  }

  /* ----------------------------- 滚动 ----------------------------- */
  let lastInputTs = 0, pointerDown = false, lastInputPost = 0;
  const onInput = (e) => {
    lastInputTs = now();
    if (e.type === 'pointerdown' || e.type === 'mousedown') pointerDown = true;
    if (lastInputTs - lastInputPost > 100) { lastInputPost = lastInputTs; post('input', {}); }
  };
  for (const t of ['wheel', 'touchstart', 'touchmove', 'keydown', 'pointerdown', 'mousedown']) {
    window.addEventListener(t, onInput, { capture: true, passive: true });
  }
  window.addEventListener('pointerup', () => { pointerDown = false; }, true);
  window.addEventListener('mouseup', () => { pointerDown = false; }, true);

  let scrollRaf = 0;
  function onScroll(e) {
    const tgt = e.target;
    const isMain = scroller ? tgt === scroller : (tgt === doc || tgt === doc.documentElement || tgt === doc.scrollingElement);
    if (!isMain) return;
    if (scrollRaf) return;
    scrollRaf = requestAnimationFrame(() => {
      scrollRaf = 0;
      const s = sstate();
      const tnow = now();
      // 先判 prog：位置等于 shell 刚下发的目标（超出可滚范围时浏览器会截断，所以和截断值比较），
      // 即使本窗格刚有过输入也算 prog —— 否则两侧都"刚有输入"时会互抢驱动权
      let cause = 'other';
      if (expect && tnow < expect.until && Math.abs(s.t - Math.min(Math.max(expect.t, 0), s.H - s.vh)) <= 2) cause = 'prog';
      else if (tnow - lastInputTs < 700 || pointerDown) cause = 'user';
      else if (tnow - lastLayoutTs < 700) cause = 'layout';
      post('scroll', { s, cause });
      if (ROLE === 'R') onScrollForTranslate();
      refreshHighlight();
    });
  }
  doc.addEventListener('scroll', onScroll, { capture: true, passive: true });

  handlers.scrollTo = (d) => {
    const s = sstate();
    if (Math.abs(s.t - d.t) < 0.5) return;
    setScroll(d.t);
  };

  /* --------------------------- 布局 / 变更 --------------------------- */
  const ro = new ResizeObserver(() => { lastLayoutTs = now(); scheduleAnchors(); });
  let applying = false;
  const pendingRoots = new Set();
  let mutTimer = 0;
  const mo = new MutationObserver((records) => {
    if (applying) return;
    for (const r of records) {
      if (r.type === 'characterData') { pendingRoots.add(r.target); continue; }
      for (const n of r.addedNodes) if (n.nodeType === 1 || n.nodeType === 3) pendingRoots.add(n);
      if (r.removedNodes.length) pendingRoots.add(r.target);
    }
    if (!mutTimer) mutTimer = setTimeout(flushMutations, 250);
  });
  function flushMutations() {
    mutTimer = 0;
    const roots = Array.from(pendingRoots);
    pendingRoots.clear();
    let changed = false;
    for (const n of roots) {
      if (!n.isConnected) continue;
      const u = seg.unitFromNode(n);
      if (u) {
        // 已有单元内容被页面改写（如 React 重渲染把译文冲掉了）
        if (ROLE === 'R' && u.tstate === 'done' && seg.currentText(u) !== u.applied) {
          u.tstate = '';
          u.text = seg.currentText(u);
          changed = true;
        }
        continue;
      }
      if (seg.scan(n).length) changed = true;
    }
    lastLayoutTs = now();
    if (changed || roots.length) scheduleAnchors();
  }

  /* ----------------------------- 高亮 ----------------------------- */
  let hlHost = null, hlLocal = null, hlRemote = null;
  const hlBoxes = {};
  function ensureHl() {
    if (hlHost) return;
    hlHost = doc.createElement('pt-overlay');
    hlHost.style.cssText = 'all:initial;position:fixed;inset:0;pointer-events:none;z-index:2147483646;';
    const sr = hlHost.attachShadow({ mode: 'closed' });
    for (const name of ['local', 'remote']) {
      const b = doc.createElement('div');
      b.style.cssText = 'position:fixed;display:none;pointer-events:none;border-radius:4px;transition:all .08s ease-out;' +
        (name === 'local' ? 'outline:2px solid rgba(59,130,246,.55);' : 'background:rgba(250,204,21,.28);outline:2px solid rgba(234,179,8,.6);');
      sr.appendChild(b);
      hlBoxes[name] = b;
    }
    doc.documentElement.appendChild(hlHost);
  }
  function drawBox(name, u) {
    if (!u) { if (hlBoxes[name]) hlBoxes[name].style.display = 'none'; return; }
    ensureHl();
    const r = seg.rectOf(u);
    const b = hlBoxes[name];
    if (!r || (r.width === 0 && r.height === 0)) { b.style.display = 'none'; return; }
    Object.assign(b.style, { display: 'block', left: r.left - 3 + 'px', top: r.top - 2 + 'px', width: r.width + 6 + 'px', height: r.height + 4 + 'px' });
  }
  function refreshHighlight() {
    if (hlLocal) drawBox('local', hlLocal);
    if (hlRemote) drawBox('remote', hlRemote);
  }
  let hoverRaf = 0, hoverEv = null;
  doc.addEventListener('mousemove', (e) => {
    if (!settings || settings.highlight === 'off') return;
    hoverEv = e;
    if (hoverRaf) return;
    hoverRaf = requestAnimationFrame(() => {
      hoverRaf = 0;
      const e2 = hoverEv;
      let node = e2.target;
      const cr = doc.caretRangeFromPoint ? doc.caretRangeFromPoint(e2.clientX, e2.clientY) : null;
      if (cr && cr.startContainer && cr.startContainer.nodeType === 3) node = cr.startContainer;
      let u = seg.unitFromNode(node);
      if (u && u.kind === 'mark') u = null;
      if (u === hlLocal) return;
      hlLocal = u;
      drawBox('local', u);
      post('hover', { k: u ? u.key : null });
    });
  }, { passive: true });
  doc.addEventListener('mouseleave', () => {
    if (!hlLocal) return;
    hlLocal = null; drawBox('local', null); post('hover', { k: null });
  });
  handlers.highlight = (d) => {
    hlRemote = d.k ? seg.byKey.get(d.k) || null : null;
    drawBox('remote', hlRemote);
  };

  /* ---------------------------- 阅读位置 ---------------------------- */
  function readingPoint() {
    const vt = viewportTop();
    let best = null;
    for (const u of seg.units) {
      if (u.fixed || !u.translatable) continue;
      const r = seg.rectOf(u);
      if (!r || r.height === 0) continue;
      if (r.bottom <= vt + 4) continue;
      if (!best || r.top < best.top) best = { u, top: r.top };
    }
    return best ? { k: best.u.key, off: best.top - vt } : null;
  }
  handlers.readingReq = () => post('reading', { p: readingPoint(), url: location.href });

  function scrollToKey(k, off) {
    const u = seg.byKey.get(k);
    if (!u) return false;
    const r = seg.rectOf(u);
    if (!r) return false;
    const s = sstate();
    setScroll(Math.max(0, s.t + (r.top - viewportTop()) - (off || 0)));
    return true;
  }

  /* ---------------------------- 导航跟随 ---------------------------- */
  const stripHash = (u) => u.split('#')[0];
  let lastUrl = stripHash(location.href);
  function checkNav() {
    const u = stripHash(location.href);
    if (u === lastUrl) return;
    lastUrl = u;
    post('nav', { url: location.href });
  }
  if (window.navigation) window.navigation.addEventListener('navigatesuccess', () => setTimeout(checkNav, 0));
  setInterval(checkNav, 1000);
  // sandbox 禁止顶层跳转：把 target=_top/_parent 的链接改成在窗格内打开
  doc.addEventListener('click', (e) => {
    const a = e.target && e.target.closest && e.target.closest('a[target]');
    if (a && /^_(top|parent)$/i.test(a.target)) a.target = '_self';
  }, true);

  /* ----------------------------- 翻译(R) ----------------------------- */
  // 成本控制（按需翻译）：
  //  · 只翻"视口 + 少量余量"内真正可见的段落；默认视口上方 0.25 屏、下方 0.5 屏（设置可改，0 = 只翻可见区）
  //  · 滚动过程中不发请求，停下 IDLE_MS 后才翻译当前位置 —— 快速划过的内容不会被翻译
  //  · 已发出但用户已经划远的请求会被取消（服务端停止生成，省输出 token）
  //  · 已是目标语言的段落、隐藏元素不发送；缓存命中不计费
  const IDLE_MS = 300;
  let lastError = '';
  let translateAll = false;
  let pumpTimer = 0, idleTimer = 0, lastScrollTs = 0;
  let batchSeq = 0, sentChars = 0, cancelled = 0;
  const inflight = new Map();          // id -> { id, batch, cancelled }
  let origLang = '';

  function providerCfg() {
    return (settings.providers || []).find((p) => p.id === settings.activeProviderId) || {};
  }
  const isScrolling = () => now() - lastScrollTs < IDLE_MS;
  function onScrollForTranslate() {
    lastScrollTs = now();
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => { cancelFar(); pump(); }, IDLE_MS + 20);
  }
  function pumpSoon() {
    if (pumpTimer) return;
    pumpTimer = setTimeout(() => { pumpTimer = 0; pump(); }, 60);
  }

  const SCRIPT = {
    zh: /\p{Script=Han}/u, ja: /[\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Han}]/u,
    ko: /\p{Script=Hangul}/u, ru: /\p{Script=Cyrillic}/u, ar: /\p{Script=Arabic}/u,
  };
  const KANA = /[\p{Script=Hiragana}\p{Script=Katakana}]/u;
  /** 段落已经是目标语言 → 不花钱翻译。优先看最近的 lang 属性，其次看文字脚本 */
  function alreadyTarget(u) {
    const tgt = String(settings.targetLang || '').toLowerCase();
    const tp = tgt.split('-')[0];
    const host = u.el || u.parent;
    const e = host && host.closest ? host.closest('[lang]') : null;
    const explicit = e && e !== doc.documentElement ? String(e.getAttribute('lang') || '').toLowerCase() : '';
    const l = explicit || origLang.toLowerCase();
    if (l && l.split('-')[0] === tp) {
      if (tp !== 'zh') return true;
      const trad = (x) => /hant|tw|hk|mo/.test(x);
      if (l === 'zh' || trad(l) === trad(tgt)) return true;
    }
    if (explicit) return false;                     // 明确标注为其他语言
    const re = SCRIPT[tp];
    if (!re) return false;                          // 拉丁语系目标无法靠脚本区分，交给引擎
    const letters = u.text.match(/\p{L}/gu) || [];
    if (!letters.length) return true;
    let hit = 0, kana = 0;
    for (const c of letters) { if (re.test(c)) hit++; if (KANA.test(c)) kana++; }
    if (tp === 'zh' && kana / letters.length > 0.05) return false;   // 日文不算中文
    return hit / letters.length > 0.6;
  }

  /** 当前窗口内待翻译的单元，按与阅读位置的距离排序 */
  function candidates(s) {
    const below = Math.max(0, Number(settings.prefetchScreens == null ? 0.5 : settings.prefetchScreens));
    const lo = translateAll ? -Infinity : s.t - s.vh * 0.25;
    const hi = translateAll ? Infinity : s.t + s.vh * (1 + below);
    const out = [];
    for (const u of seg.units) {
      if (!u.translatable || u.tstate || Number.isNaN(u.y)) continue;   // NaN = 不可见 / 未测量
      let dist;
      if (u.fixed) {
        // 固定/吸顶元素（导航、目录、工具栏）：只翻当前可见的，且排在视口正文之后
        const visible = u.vy + u.h > 0 && u.vy < s.vh;
        if (!visible && !translateAll) continue;
        dist = visible ? s.vh * 0.75 : s.vh * 50;
      } else {
        if (u.y + u.h < lo || u.y > hi) continue;
        dist = u.y < s.t ? (s.t - u.y) * 1.5 : u.y - s.t;
      }
      out.push([dist, u]);
    }
    out.sort((a, b) => a[0] - b[0]);
    return out;
  }

  function pump() {
    if (ROLE !== 'R' || !settings) return;
    if (isScrolling() && !translateAll) { postStatus(); return; }      // 滚动中不发请求
    const cfg = providerCfg();
    const conc = Math.max(1, Math.min(cfg.concurrency || 3, 8));
    if (inflight.size >= conc) { postStatus(); return; }
    const items = [];
    let total = 0;
    for (const [, u] of candidates(sstate())) {
      if (alreadyTarget(u)) { u.tstate = 'skip'; continue; }
      const ser = seg.serialize(u);
      if (!ser.text || !/\p{L}/u.test(ser.text)) { u.tstate = 'skip'; continue; }
      items.push({ u, ser });
      total += ser.text.length;
    }
    // 把窗口内的文字均分给空闲并发槽：首屏结果出来得更快，批次也不会超过引擎上限
    const free = conc - inflight.size;
    const maxChars = Math.min(cfg.batchChars || 2400, Math.max(300, Math.ceil(total / free)));
    const maxN = cfg.batchSize || 24;
    let i = 0;
    while (inflight.size < conc && i < items.length) {
      const batch = [];
      let chars = 0;
      while (i < items.length) {
        const it = items[i];
        if (batch.length && (chars + it.ser.text.length > maxChars || batch.length >= maxN)) break;
        batch.push(it); chars += it.ser.text.length; i++;
      }
      startBatch(batch);
    }
    postStatus();
  }

  function startBatch(batch) {
    const rec = { id: ++batchSeq, batch, cancelled: false };
    inflight.set(rec.id, rec);
    for (const it of batch) it.u.tstate = 'inflight';
    runBatch(rec).finally(() => { inflight.delete(rec.id); postStatus(); pumpSoon(); });
  }

  /** 用户已经划远：取消仍在途、且整批都离开阅读区域的请求 */
  function cancelFar() {
    if (translateAll) return;
    const s = sstate();
    const lo = s.t - s.vh * 1.5, hi = s.t + s.vh * 2.5;
    for (const rec of Array.from(inflight.values())) {
      // 固定元素（导航栏等）始终"可见"，不参与判断；整批正文都已远离才取消
      const body = rec.batch.filter(({ u }) => !u.fixed && !Number.isNaN(u.y));
      if (!body.length || body.some(({ u }) => u.y + u.h >= lo && u.y <= hi)) continue;
      rec.cancelled = true;
      inflight.delete(rec.id);
      cancelled++;
      for (const it of rec.batch) it.u.tstate = '';
      chrome.runtime.sendMessage({ type: 'translate:cancel', reqId: TOKEN + ':' + rec.id }).catch(() => {});
    }
  }

  async function runBatch(rec) {
    const { batch } = rec;
    let res;
    try {
      res = await chrome.runtime.sendMessage({
        type: 'translate',
        reqId: TOKEN + ':' + rec.id,
        segments: batch.map((it) => it.ser.text),
        page: { title: doc.title, url: location.href },
      });
    } catch (e) {
      res = { error: String((e && e.message) || e) };
    }
    if (rec.cancelled) return;
    if (!res || res.error || !Array.isArray(res.results)) {
      lastError = (res && res.error) || PT.t('err.translate');
      for (const it of batch) it.u.tstate = 'error';
      return;
    }
    lastError = '';
    sentChars += res.sentChars || 0;
    applying = true;
    try {
      batch.forEach((it, i) => {
        const u = it.u;
        const tr = res.results[i];
        if (typeof tr !== 'string' || !seg.isAlive(u)) { u.tstate = 'error'; return; }
        // 请求期间页面改写了这段原文 → 丢弃，稍后重译
        if (seg.serialize(u).text !== it.ser.text) { u.tstate = ''; return; }
        seg.apply(u, it.ser, tr);
        u.applied = seg.currentText(u);
        u.tstate = 'done';
        const el = it.ser.container;
        if (el && el.animate) el.animate([{ opacity: 0.25 }, { opacity: 1 }], { duration: 280, easing: 'ease-out' });
      });
    } finally {
      mo.takeRecords();
      applying = false;
    }
    lastLayoutTs = now();
    scheduleAnchors();
  }

  let statusTimer = 0;
  function postStatus() {
    if (statusTimer) return;
    statusTimer = setTimeout(() => {
      statusTimer = 0;
      let total = 0, done = 0, err = 0, leftN = 0, leftChars = 0;
      for (const u of seg.units) {
        if (!u.translatable || u.tstate === 'skip') continue;
        if (!u.tstate && Number.isNaN(u.y)) continue;      // 当前不可见（折叠菜单、被媒体查询隐藏）不计入
        total++;
        if (u.tstate === 'done') done++;
        else if (u.tstate === 'error') err++;
        else if (!u.tstate) { leftN++; leftChars += u.text.length; }
      }
      post('status', { total, done, err, inflight: inflight.size, error: lastError, sent: sentChars, cancelled, leftN, leftChars });
    }, 200);
  }
  handlers.retry = () => {
    for (const u of seg.units) if (u.tstate === 'error') u.tstate = '';
    lastError = '';
    pump();
  };
  handlers.translateAll = () => { translateAll = true; pump(); };

  /* ------------------------------ 启动 ------------------------------ */
  let inited = false;
  handlers.init = (d) => {
    if (inited) return;
    inited = true;
    if (d.initial && d.initial.k) {
      // 打开分屏时：左窗格定位到用户原来正在读的段落
      const tryScroll = (n) => { if (!scrollToKey(d.initial.k, d.initial.off) && n > 0) setTimeout(() => tryScroll(n - 1), 300); };
      tryScroll(5);
    }
  };

  async function start() {
    settings = await PT.loadSettings();
    chrome.storage.onChanged.addListener((ch, area) => {
      if (area !== 'local' || !ch.settings) return;
      settings = Object.assign({}, PT.DEFAULTS, ch.settings.newValue || {});
      if (settings.highlight === 'off') { hlLocal = hlRemote = null; drawBox('local', null); drawBox('remote', null); }
    });
    if (ROLE === 'R') {
      origLang = doc.documentElement.getAttribute('lang') || '';
      doc.documentElement.lang = settings.targetLang;
      doc.documentElement.setAttribute('data-pt-translated', settings.targetLang);
    }
    scroller = detectScroller();
    seg.scan(doc.body);
    ro.observe(doc.documentElement);
    if (doc.body) ro.observe(doc.body);
    if (scroller) ro.observe(scroller);
    mo.observe(doc.body || doc.documentElement, { childList: true, subtree: true, characterData: true });
    window.addEventListener('resize', () => { lastLayoutTs = now(); scheduleAnchors(true); });
    window.addEventListener('load', () => { lastLayoutTs = now(); scheduleAnchors(true); });
    // 兜底：每 1.5s 重新检测滚动容器（SPA 可能切换布局），签名不变时不会重复上报
    setInterval(() => {
      const sc = detectScroller();
      if (sc !== scroller) { scroller = sc; if (sc) ro.observe(sc); scheduleAnchors(true); }
      else scheduleAnchors();
    }, 1500);
    post('hello', { url: location.href, title: doc.title, s: sstate() });
    scheduleAnchors(true);
  }
  if (doc.readyState === 'loading') doc.addEventListener('DOMContentLoaded', start, { once: true });
  else start();
})();
