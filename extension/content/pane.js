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
      out.push({ k: u.key, t: Math.round(u.y * 10) / 10, b: Math.round((u.y + u.h) * 10) / 10, n: u.text.length });
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
  let lastInputTs = -1e9, pointerDown = false, lastInputPost = -1e9;   // 同上：不能用 0（新 iframe 的 now() 从 0 起）
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

  let scrollRaf = 0, lastScrollT = 0, scrollDir = 1;
  function onScroll(e) {
    const tgt = e.target;
    const isMain = scroller ? tgt === scroller : (tgt === doc || tgt === doc.documentElement || tgt === doc.scrollingElement);
    if (!isMain) return;
    if (scrollRaf) return;
    scrollRaf = requestAnimationFrame(() => {
      scrollRaf = 0;
      const s = sstate();
      const tnow = now();
      if (s.t !== lastScrollT) { scrollDir = s.t > lastScrollT ? 1 : -1; lastScrollT = s.t; }
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
  const MAX_REWRITES = 2;
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
        // 已有单元内容被页面改写（如 React 重渲染把译文冲掉了）→ 重译。
        // 防死循环、防烧钱：①改写后的内容里还带着我们的译文（页面是追加/混入，不是恢复原文）→ 不重译；
        // ②每段最多重译 MAX_REWRITES 次。
        if (ROLE === 'R' && u.tstate === 'done') {
          const cur = seg.currentText(u);
          if (cur !== u.applied) {
            u.rewrites = (u.rewrites || 0) + 1;
            const mixed = !!u.applied && (cur.includes(u.applied) || u.applied.includes(cur));
            if (!mixed && u.rewrites <= MAX_REWRITES) { u.tstate = ''; u.cprobed = false; u.text = cur; changed = true; }
            else u.applied = cur;   // 接受页面的改写，不再追
          }
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
  const MIN_BATCH = 300;   // 单批最少字符：再小的话请求固定开销（提示词、首 token 延迟）占比太高
  let lastError = '', lastErrorCode = '';
  let translateAll = false;
  // lastScrollTs 初值必须是"很久以前"：performance.now() 在新 iframe 里从 0 起算，初值 0 会让开头 300ms 被当成"正在滚动"，
  // 首次翻译被推迟到 1.5s 的兜底定时器（实测首屏晚 ~1.4s）
  let pumpTimer = 0, idleTimer = 0, lastScrollTs = -1e9;
  let batchSeq = 0, sentChars = 0, cancelled = 0;
  // 用量：缓存命中段数（本地，免费）、去重省掉的段数、服务端返回的 token（含命中服务端前缀缓存的部分）
  let cacheHits = 0, dedupSaved = 0;
  const usage = { req: 0, inTok: 0, cachedTok: 0, outTok: 0, est: false };
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
    // 滚动中也查本地缓存：命中是免费的，快速划过看过的内容也能立刻显示译文
    if (now() - lastProbeTs > 250) probeCache('wide');
  }

  /* 缓存优先：还没查过缓存的段落先只查本地缓存（不发网络请求），命中直接回填。
   *   near：覆盖翻译窗口（视口上 1.5 屏 ~ 下 2.5 屏），翻译前等它返回（很小，几毫秒）
   *   wide：视口上 3 屏 ~ 下 4 屏，后台查，不挡住网络请求；滚动中也查 */
  const PROBE = { near: [1.5, 2.5, 120], wide: [3, 4, 300] };
  let lastProbeTs = 0;
  function probeCache(kind) {
    if (ROLE !== 'R' || !settings) return null;
    if (kind === 'wide') lastProbeTs = now();
    const [above, below, max] = PROBE[kind];
    const s = sstate();
    const lo = s.t - s.vh * above, hi = s.t + s.vh * below;
    const items = [];
    for (const u of seg.units) {
      if (!u.translatable || u.tstate || u.cprobed || Number.isNaN(u.y)) continue;
      if (!u.fixed && (u.y + u.h < lo || u.y > hi)) continue;
      if (alreadyTarget(u)) { u.tstate = 'skip'; continue; }
      const ser = seg.serialize(u);
      if (!ser.text || !/\p{L}/u.test(ser.text)) { u.tstate = 'skip'; continue; }
      u.cprobed = true;
      items.push({ u, ser });
      if (items.length >= max) break;
    }
    if (!items.length) return null;
    return chrome.runtime.sendMessage({
      type: 'translate', cacheOnly: true,
      segments: items.map((it) => it.ser.text),
      page: { title: doc.title, url: location.href },
    }).then((res) => {
      if (!res || !Array.isArray(res.results)) return;
      let n = 0;
      items.forEach((it, i) => {
        const v = res.results[i];
        if (typeof v === 'string' && !it.u.tstate && applyItem(it, v)) n++;
      });
      if (n) { cacheHits += n; lastLayoutTs = now(); scheduleAnchors(); postStatus(); }
    }).catch(() => {});
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
    // 按滚动方向预取：往下读时多翻下方，往回翻时多翻上方
    let lo = s.t - s.vh * 0.25, hi = s.t + s.vh * (1 + below);
    if (scrollDir < 0) { lo = s.t - s.vh * below; hi = s.t + s.vh * 1.25; }
    if (translateAll) { lo = -Infinity; hi = Infinity; }
    const out = [];
    for (const u of seg.units) {
      if (!u.translatable || u.tstate || Number.isNaN(u.y)) continue;   // NaN = 不可见 / 未测量
      let dist, vis;
      if (u.fixed) {
        // 固定/吸顶元素（导航、目录、工具栏）：只翻当前可见的，且排在视口正文之后
        vis = u.vy + u.h > 0 && u.vy < s.vh;
        if (!vis && !translateAll) continue;
        dist = vis ? s.vh * 0.75 : s.vh * 50;
      } else {
        if (u.y + u.h < lo || u.y > hi) continue;
        dist = u.y < s.t ? (s.t - u.y) * 1.5 : u.y - s.t;
        // 第一波（"可见"）带上上方 0.25 屏 / 下方 0.1 屏余量：跟随方对齐后视口会挪动几十～上百 px
        vis = u.y < s.t + s.vh * 1.1 && u.y + u.h > s.t - s.vh * 0.25;
      }
      out.push([dist, u, vis]);
    }
    out.sort((a, b) => a[0] - b[0]);
    return out;
  }

  function pump() {
    if (ROLE !== 'R' || !settings) return;
    if (isScrolling() && !translateAll) { postStatus(); return; }      // 滚动中不发请求
    const pr = probeCache('near');
    if (pr) { pr.then(() => pump()); return; }                              // 先用免费的本地缓存，再决定发什么
    probeCache('wide');                                                 // 更远处的缓存后台查，不挡请求
    const cfg = providerCfg();
    const conc = Math.max(1, Math.min(cfg.concurrency || 3, 8));
    if (inflight.size >= conc) { postStatus(); return; }
    const items = [];
    const lead = new Map();   // 同一原文在本页出现多次（"回复""分享"、重复的导航）：只发一次，译文复制给其余段落
    for (const [, u, vis] of candidates(sstate())) {
      if (alreadyTarget(u)) { u.tstate = 'skip'; continue; }
      const ser = seg.serialize(u);
      if (!ser.text || !/\p{L}/u.test(ser.text)) { u.tstate = 'skip'; continue; }
      const first = lead.get(ser.text);
      if (first) { (first.followers || (first.followers = [])).push({ u, ser }); continue; }
      const it = { u, ser, vis };
      lead.set(ser.text, it);
      items.push(it);
    }
    // 可见区优先：先把屏幕上的段落均分给所有空闲并发槽（每路流更短 → 整屏更快翻完），
    // 预取部分等有空槽再发。批次内保持文档顺序的相邻段落，模型有上下文。
    const maxN = cfg.batchSize || 24;
    const maxC = cfg.batchChars || 2400;
    const send = (list, visible) => {
      let left = list.reduce((n, it) => n + it.ser.text.length, 0);
      let i = 0;
      while (inflight.size < conc && i < list.length) {
        // 可见波：每批目标 = 剩余字数 / 剩余空槽，最后一个空槽兜底拿走剩下的（只受引擎上限约束），屏幕上的段落一次发完；
        // 预取波：按总并发数切小块，空槽有几个发几块，其余等下一个空槽 —— 不会把整片预取区塞进一路慢吞吞的长流
        const slots = conc - inflight.size;
        const target = visible
          ? (slots <= 1 ? maxC : Math.min(maxC, Math.max(MIN_BATCH, Math.ceil(left / slots))))
          : Math.min(maxC, Math.max(MIN_BATCH, Math.ceil(left / conc)));
        const batch = [];
        let chars = 0;
        while (i < list.length) {
          const len = list[i].ser.text.length;
          if (batch.length && (batch.length >= maxN || chars + len > maxC || chars + len / 2 > target)) break;
          batch.push(list[i]); chars += len; i++;
        }
        left -= chars;
        startBatch(batch);
      }
    };
    if (translateAll) send(items, true);
    else {
      send(items.filter((it) => it.vis), true);
      send(items.filter((it) => !it.vis), false);
    }
    postStatus();
  }

  function startBatch(batch) {
    const rec = { id: ++batchSeq, batch, cancelled: false };
    inflight.set(rec.id, rec);
    for (const it of batch) {
      it.u.tstate = 'inflight'; setPending(it);
      for (const f of it.followers || []) { f.u.tstate = 'inflight'; setPending(f); dedupSaved++; }
    }
    runBatch(rec).finally(() => {
      for (const it of batch) { clearPending(it); for (const f of it.followers || []) { clearPending(f); if (f.u.tstate === 'inflight') f.u.tstate = ''; } }
      inflight.delete(rec.id); postStatus(); pumpSoon();
    });
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
      for (const it of rec.batch) {
        for (const x of [it].concat(it.followers || [])) { clearPending(x); if (x.u.tstate === 'inflight') x.u.tstate = ''; }
      }
      chrome.runtime.sendMessage({ type: 'translate:cancel', reqId: TOKEN + ':' + rec.id }).catch(() => {});
    }
  }

  /** "正在翻译"提示：段落透明度呼吸。用 Web Animations，不改页面属性/样式，也不受页面 CSP 影响 */
  function setPending(it) {
    const el = it.ser.container || (it.u.el) || null;
    if (!el || !el.animate || it.anim) return;
    it.anim = el.animate([{ opacity: 1 }, { opacity: 0.4 }, { opacity: 1 }], { duration: 1200, iterations: Infinity, easing: 'ease-in-out' });
  }
  function clearPending(it) {
    if (it.anim) { it.anim.cancel(); it.anim = null; }
  }

  /** 回填一段译文（流式到达或整批返回都走这里）；同一段可被更新（以最终结果为准） */
  function applyItem(it, tr) {
    const u = it.u;
    if (typeof tr !== 'string') return false;
    if (it.applied === tr) return true;
    if (!seg.isAlive(u)) return false;
    // 第一次回填前确认原文没被页面改写；改写了就丢弃，稍后重译
    if (it.applied == null && seg.serialize(u).text !== it.ser.text) { clearPending(it); u.tstate = ''; return false; }
    applying = true;
    try { seg.apply(u, it.ser, tr); } finally { mo.takeRecords(); applying = false; }
    const first = it.applied == null;
    it.applied = tr;
    u.applied = seg.currentText(u);
    u.tstate = 'done';
    clearPending(it);
    const el = it.ser.container;
    if (first && el && el.animate) el.animate([{ opacity: 0.25 }, { opacity: 1 }], { duration: 280, easing: 'ease-out' });
    for (const f of it.followers || []) applyItem(f, tr);
    return true;
  }

  // 流式：SW 每翻好一段就推过来
  chrome.runtime.onMessage.addListener((m) => {
    if (!m || m.type !== 'translate:partial' || typeof m.reqId !== 'string') return;
    const [tok, id] = m.reqId.split(':');
    if (tok !== TOKEN) return;
    const rec = inflight.get(+id);
    if (!rec || rec.cancelled) return;
    const it = rec.batch[m.i];
    if (it && applyItem(it, m.text)) { lastLayoutTs = now(); scheduleAnchors(); postStatus(); }
  });

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
      lastErrorCode = (res && res.code) || '';
      for (const it of batch) for (const x of [it].concat(it.followers || [])) if (x.applied == null) x.u.tstate = 'error';
      return;
    }
    lastError = ''; lastErrorCode = '';
    sentChars += res.sentChars || 0;
    cacheHits += res.cacheHits || 0;
    dedupSaved += res.dedup || 0;
    if (res.usage) for (const k of ['req', 'inTok', 'cachedTok', 'outTok']) usage[k] += res.usage[k] || 0;
    if (res.usage && res.usage.est) usage.est = true;
    batch.forEach((it, i) => {
      if (!applyItem(it, res.results[i]) && it.u.tstate === 'inflight') it.u.tstate = 'error';
    });
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
      post('status', { total, done, err, inflight: inflight.size, error: lastError, errCode: lastErrorCode, sent: sentChars, cancelled, leftN, leftChars,
        cacheHits, dedup: dedupSaved, usage });
    }, 200);
  }
  handlers.retry = () => {
    for (const u of seg.units) { if (u.tstate === 'error') u.tstate = ''; u.cprobed = false; }
    lastError = ''; lastErrorCode = '';
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
    // 反爬虫验证页（Cloudflare 等）：告诉外壳，给用户一个明确的提示
    const head = (doc.title + ' ' + (doc.body ? doc.body.innerText.slice(0, 600) : '')).toLowerCase();
    const challenge = /just a moment|attention required|security verification|verify you are human|checking your browser|请稍候|安全验证/.test(head);
    post('hello', { url: location.href, title: doc.title, s: sstate(), challenge });
    scheduleAnchors(true);
  }
  if (doc.readyState === 'loading') doc.addEventListener('DOMContentLoaded', start, { once: true });
  else start();
})();
