/*
 * sw.js — 后台 Service Worker
 *   - 工具栏按钮 / 快捷键 / 右键菜单 → 向当前标签页注入 shell
 *   - 分屏期间为该标签页挂 DNR 会话规则（子框架去掉 X-Frame-Options / CSP）
 *   - 窗格 bootstrap 报到 → 向该 frame 注入完整窗格代理
 *   - 翻译请求：缓存 → 分块 → 按引擎并发限流 → 调用 provider
 * API Key 只存在 chrome.storage.local，只在 SW 里使用，不会进入网页上下文。
 */
importScripts('../shared/defaults.js', '../shared/i18n.js', 'providers.js', 'cache.js');

const PT = globalThis.PT;
const SHELL_FILES = ['shared/defaults.js', 'shared/i18n.js', 'shared/sync-core.js', 'shared/segment.js', 'content/shell.js'];
const PANE_FILES = ['shared/defaults.js', 'shared/i18n.js', 'shared/sync-core.js', 'shared/segment.js', 'content/pane.js'];

/* ------------------------------ 入口 ------------------------------ */
chrome.runtime.onInstalled.addListener(async (details) => {
  if (details.reason === 'install') {
    // 首次安装：目标语言跟随浏览器语言，并打开引导页
    const { settings } = await chrome.storage.local.get('settings');
    if (!settings) await PT.saveSettings({ targetLang: PT.guessTargetLang(navigator.language) });
    chrome.tabs.create({ url: chrome.runtime.getURL('welcome/welcome.html') });
  }
  await PT.loadSettings();
  chrome.contextMenus.create({ id: 'pt-split', title: PT.t('ctx.menu'), contexts: ['page', 'selection', 'link', 'image'] });
});
// 界面语言切换后更新右键菜单文字
chrome.storage.onChanged.addListener(async (ch, area) => {
  if (area !== 'local' || !ch.settings) return;
  await PT.loadSettings();
  chrome.contextMenus.update('pt-split', { title: PT.t('ctx.menu') }).catch(() => {});
});
// 点击图标打开弹窗（popup/）；快捷键直接开关分屏
chrome.commands.onCommand.addListener(async (cmd, tab) => {
  if (cmd !== 'toggle-split') return;
  const t = tab || (await chrome.tabs.query({ active: true, currentWindow: true }))[0];
  if (t) toggle(t.id, {});
});
chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId === 'pt-split' && tab) toggle(tab.id, { fromContext: info.frameId === 0 });
});
chrome.tabs.onRemoved.addListener((tabId) => splitOff(tabId));

async function toggle(tabId, opts) {
  try {
    await chrome.scripting.executeScript({ target: { tabId }, func: (o) => { globalThis.__ptShellOpts = o; }, args: [opts] });
    await chrome.scripting.executeScript({ target: { tabId }, files: SHELL_FILES });
  } catch (e) {
    // edge:// 、扩展商店、PDF 查看器等页面不允许注入
    console.warn('[Duet-Translator] inject failed:', e);
    chrome.action.setBadgeText({ tabId, text: '×' });
    chrome.action.setBadgeBackgroundColor({ tabId, color: '#b91c1c' });
    setTimeout(() => chrome.action.setBadgeText({ tabId, text: '' }), 2500);
  }
}
globalThis.PT_toggleTab = toggle;   // 调试/测试用

// 缓存上限跟随设置；SW 醒来时若距上次整理超过 6 小时，顺手整理一次（TTL 过期 + 超预算淘汰）
async function configureCache() {
  const s = await PT.loadSettings();
  PT.cache.configure({ maxMB: s.cacheMaxMB, ttlDays: s.cacheTTLDays, maxEntries: s.cacheMaxEntries });
}
configureCache().then(async () => {
  const inf = await PT.cache.info('').catch(() => null);
  const last = inf && inf.lastPrune ? inf.lastPruneAt : 0;
  if (!last || Date.now() - last > 6 * 3600e3) setTimeout(() => PT.cache.prune().catch(() => {}), 8000);
}).catch(() => {});
chrome.storage.onChanged.addListener((ch, area) => { if (area === 'local' && ch.settings) configureCache().catch(() => {}); });

/* --------------------------- 分屏会话 / DNR --------------------------- */
async function splitOn(tabId) {
  await chrome.storage.session.set({ ['split:' + tabId]: Date.now() });
  const s = await PT.loadSettings();
  const removeRuleIds = [tabId];
  const addRules = s.stripFrameHeaders ? [{
    id: tabId,
    priority: 1,
    action: {
      type: 'modifyHeaders',
      responseHeaders: [
        { header: 'x-frame-options', operation: 'remove' },
        { header: 'content-security-policy', operation: 'remove' },
      ],
    },
    condition: { tabIds: [tabId], resourceTypes: ['sub_frame'] },
  }] : [];
  await chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds, addRules });
}
async function splitOff(tabId) {
  await chrome.storage.session.remove('split:' + tabId);
  await chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: [tabId] }).catch(() => {});
}
async function isSplit(tabId) {
  const k = 'split:' + tabId;
  return !!(await chrome.storage.session.get(k))[k];
}

/* ----------------------------- 翻译 ----------------------------- */
const sems = new Map();
function getSem(id, n) {
  let s = sems.get(id);
  if (!s) { s = { n, active: 0, q: [] }; sems.set(id, s); }
  s.n = n;
  return s;
}
async function withSem(s, fn) {
  while (s.active >= s.n) await new Promise((r) => s.q.push(r));
  s.active++;
  try { return await fn(); } finally {
    s.active--;
    const next = s.q.shift();
    if (next) next();
  }
}
function chunk(idx, segs, cfg) {
  const maxN = cfg.batchSize || 24, maxC = cfg.batchChars || 2400;
  const out = [];
  let cur = [], chars = 0;
  for (const i of idx) {
    const len = segs[i].length;
    if (cur.length && (cur.length >= maxN || chars + len > maxC)) { out.push(cur); cur = []; chars = 0; }
    cur.push(i); chars += len;
  }
  if (cur.length) out.push(cur);
  return out;
}

const aborts = new Map();   // reqId -> AbortController（窗格划远后取消在途请求）

async function translate(msg, sender) {
  const ac = msg.reqId ? new AbortController() : null;
  if (ac) aborts.set(msg.reqId, ac);
  // 流式：每翻好一段就立刻推给发起请求的窗格（不等整批完成）
  const tabId = sender && sender.tab && sender.tab.id;
  const send = (m) => chrome.tabs.sendMessage(tabId, Object.assign({ type: 'translate:partial', reqId: msg.reqId }, m), { frameId: sender.frameId }).catch(() => {});
  const partial = msg.reqId && tabId != null && sender.frameId != null ? (i, text) => send({ i, text }) : null;
  // 段内预览：某段还在生成时，把目前为止的译文推过去（每段最多 150ms 一次），长段落不用干等
  const lastPrev = new Map();
  const preview = partial ? (i, text) => {
    const t = Date.now();
    if (t - (lastPrev.get(i) || 0) < 150) return;
    lastPrev.set(i, t);
    send({ i, text, preview: true });
  } : null;
  try { return await translateInner(msg, ac && ac.signal, partial, preview); } finally { if (ac) aborts.delete(msg.reqId); }
}

/** 把常见的服务端报错翻成能照着改的提示（原始信息附在后面便于排查） */
function friendlyError(e, cfg) {
  const m = String((e && e.message) || e);
  const host = (() => { try { return new URL(cfg.baseUrl || cfg.endpoint).hostname; } catch (_) { return ''; } })();
  if (/HTTP 40[13]/.test(m) && cfg.type !== 'mock') {
    if (!PT.hasKey(cfg)) return noKeyError();
    const err = new Error(PT.t('err.badKey') + (/minimax/i.test(host) ? ' ' + PT.t('err.hintMinimax') : '') + ' — ' + m.slice(0, 200));
    err.code = 'badKey';
    return err;
  }
  if (/HTTP 400/.test(m) && /thinking|reasoning/i.test(m)) return new Error(PT.t('err.thinking') + ' — ' + m.slice(0, 200));
  return e;
}

function noKeyError() {
  const e = new Error(PT.t('err.noKey'));
  e.code = 'noKey';
  return e;
}

async function translateInner(msg, signal, partial, preview) {
  const settings = await PT.loadSettings();
  const cfg = msg.cfg || (settings.providers || []).find((p) => p.id === settings.activeProviderId);
  if (!cfg) throw new Error(PT.t('err.noProvider'));
  const impl = PT.providers[cfg.type];
  if (!impl) throw new Error(PT.t('err.unknownType', { type: cfg.type }));
  const ctx = { from: settings.sourceLang || 'auto', to: msg.to || settings.targetLang, page: msg.page || {}, signal };
  const segs = msg.segments || [];
  const results = new Array(segs.length);
  if (!msg.cacheOnly && PT.needsKey(cfg) && !PT.hasKey(cfg)) throw noKeyError();   // 不发请求，直接提示
  try {
    return await translateCore(msg, cfg, impl, ctx, segs, results, signal, partial, preview);
  } catch (e) {
    throw friendlyError(e, cfg);
  }
}

/** 缓存命名空间：引擎|模型|语言对；用了自定义提示词时追加其哈希（改提示词 = 自动换一套缓存，旧的靠 LRU/TTL 自然淘汰） */
function cacheNs(cfg, ctx) {
  let ns = [cfg.type, cfg.id, cfg.model || '', ctx.from, ctx.to].join('|');
  const sp = String(cfg.systemPrompt || '').trim();
  if (sp) {
    let h = 0;
    for (let i = 0; i < sp.length; i++) h = (h * 31 + sp.charCodeAt(i)) | 0;
    ns += '|sp' + (h >>> 0).toString(36);
  }
  return ns;
}
const hostOf = (u) => { try { return new URL(u).hostname; } catch (_) { return ''; } };
const pageOf = (u) => String(u || '').split('#')[0];

/** 译文里的占位标签必须和原文一一对应，否则（模型弄乱了标签）不写缓存，下次重新翻译 */
function tagsOk(src, out) {
  if (typeof out !== 'string' || !out.trim()) return false;
  const tags = (x) => (x.match(/<\/?g\d+>|<x\d+\/>/g) || []).sort().join(',');
  return tags(src) === tags(out);
}

// 在途去重：同一段原文（同一命名空间）正在被别的请求翻译时，直接等它的结果，不重复花钱
const pending = new Map();   // cacheKey -> { promise, resolve, reject }
function deferred() {
  let resolve, reject;
  const promise = new Promise((a, b) => { resolve = a; reject = b; });
  promise.catch(() => {});
  return { promise, resolve, reject };
}

// 累计用量（按引擎）：设置页展示 token 与估算费用
const usageAcc = new Map();
let usageTimer = 0;
function addUsage(cfgId, u) {
  if (!u) return;
  const a = usageAcc.get(cfgId) || { req: 0, inTok: 0, cachedTok: 0, outTok: 0, est: 0 };
  a.req++; a.inTok += u.inTok || 0; a.cachedTok += u.cachedTok || 0; a.outTok += u.outTok || 0; if (u.est) a.est++;
  usageAcc.set(cfgId, a);
  if (!usageTimer) usageTimer = setTimeout(flushUsage, 3000);
}
async function flushUsage() {
  usageTimer = 0;
  if (!usageAcc.size) return;
  const add = Array.from(usageAcc); usageAcc.clear();
  const { usage = {} } = await chrome.storage.local.get('usage');
  for (const [id, a] of add) {
    const u = usage[id] || { req: 0, inTok: 0, cachedTok: 0, outTok: 0, est: 0, since: Date.now() };
    for (const k of ['req', 'inTok', 'cachedTok', 'outTok', 'est']) u[k] = (u[k] || 0) + a[k];
    usage[id] = u;
  }
  await chrome.storage.local.set({ usage });
}

async function translateCore(msg, cfg, impl, ctx, segs, results, signal, partial, preview) {
  const useCache = cfg.type !== 'mock' && !msg.noCache;
  const ns = cacheNs(cfg, ctx);
  const host = hostOf(ctx.page && ctx.page.url), page = pageOf(ctx.page && ctx.page.url);
  const usage = { req: 0, inTok: 0, cachedTok: 0, outTok: 0, est: false };
  ctx = Object.assign({}, ctx, {
    onUsage: (u) => {
      if (!u) return;
      usage.req++; usage.inTok += u.inTok; usage.cachedTok += u.cachedTok; usage.outTok += u.outTok; if (u.est) usage.est = true;
      addUsage(cfg.id, u);
    },
  });
  const ks = useCache ? await PT.cache.keys(ns, segs) : segs.map((t) => ns + '\u0000' + t);
  let cacheHits = 0;
  if (useCache && !msg.refresh) {
    const hit = await PT.cache.getMany(ks, segs);
    hit.forEach((v, i) => { if (typeof v === 'string') { results[i] = v; cacheHits++; if (partial) partial(i, v); } });
  }
  if (msg.cacheOnly) return { results, sentChars: 0, cacheHits };

  // 同一请求内重复的原文只发一次；别的请求正在翻的原文直接等结果
  const groups = new Map();   // key -> [下标…]
  segs.forEach((_, i) => {
    if (results[i] !== undefined) return;
    const g = groups.get(ks[i]);
    if (g) g.push(i); else groups.set(ks[i], [i]);
  });
  const fill = (idxs, v, final) => {
    for (const i of idxs) { if (final) results[i] = v; if (partial) partial(i, v); }
  };
  const own = [], waits = [];
  const claim = (k, idxs) => { const d = deferred(); pending.set(k, d); return [k, idxs, d]; };
  const release = (g, v, ok) => {   // 只撤掉自己登记的那份（refresh 可能覆盖过别人的登记）
    const [k, , d] = g;
    if (ok) d.resolve(v); else d.reject(new Error('owner failed'));
    if (pending.get(k) === d) pending.delete(k);
  };
  for (const [k, idxs] of groups) {
    const p = pending.get(k);
    if (!msg.refresh && p) waits.push([k, idxs, p.promise]);
    else own.push(claim(k, idxs));
  }

  let sentChars = 0, dedup = 0;
  for (const [, idxs] of groups) dedup += idxs.length - 1;
  const sendGroups = async (list) => {
    if (!list.length) return;
    const sem = getSem(cfg.id, Math.max(1, cfg.concurrency || 3));
    const lead = list.map((g) => g[1][0]);
    const byLead = new Map(list.map((g) => [g[1][0], g]));
    await Promise.all(chunk(lead, segs, cfg).map((ch) => withSem(sem, async () => {
      if (signal && signal.aborted) throw new Error('cancelled');
      sentChars += ch.reduce((n, i) => n + segs[i].length, 0);
      const cctx = partial ? Object.assign({}, ctx, {
        onItem: (j, text) => { if (ch[j] != null) fill(byLead.get(ch[j])[1], text, false); },
        onPartial: preview ? (j, text) => { if (ch[j] != null) for (const i of byLead.get(ch[j])[1]) preview(i, text); } : null,
      }) : ctx;
      const out = await impl.translate(ch.map((i) => segs[i]), cfg, cctx);
      if (!Array.isArray(out) || out.length !== ch.length) throw new Error(PT.t('err.count'));
      const okK = [], okV = [];
      ch.forEach((i, j) => {
        const g = byLead.get(i);
        fill(g[1], out[j], true);
        release(g, out[j], true);
        g.done = true;
        if (useCache && tagsOk(segs[i], out[j])) { okK.push(g[0]); okV.push(out[j]); }
      });
      if (okK.length) await PT.cache.putMany(okK, okV, { host, page, ns });
    })));
  };

  // 失败 / 取消：没完成的在途登记要撤掉，等待它们的请求会自己重新发
  const releaseRest = (list) => { for (const g of list) if (!g.done) release(g, null, false); };
  try { await sendGroups(own); } finally { releaseRest(own); }
  if (waits.length) {
    const retry = [];
    await Promise.all(waits.map(async ([k, idxs, p]) => {
      try { fill(idxs, await p, true); } catch (_) { retry.push([k, idxs]); }
    }));
    if (retry.length) {
      if (signal && signal.aborted) throw new Error('cancelled');
      const mine = retry.map(([k, idxs]) => claim(k, idxs));
      try { await sendGroups(mine); } finally { releaseRest(mine); }
    }
  }
  return { results, sentChars, cacheHits, dedup, usage };
}

/* ----------------------------- 消息路由 ----------------------------- */
const handlers = {
  'split:on': (m, s) => splitOn(s.tab.id).then(() => ({ ok: true })),
  'split:off': (m, s) => splitOff(s.tab.id).then(() => ({ ok: true })),
  toggle: (m) => toggle(m.tabId, {}).then(() => ({ ok: true })),
  splitState: async (m) => {
    try {
      const [r] = await chrome.scripting.executeScript({
        target: { tabId: m.tabId },
        func: () => !!(globalThis.__ptShell && globalThis.__ptShell.active),
      });
      return { state: r && r.result ? 'on' : 'off' };
    } catch (_) {
      return { state: 'unavailable' };
    }
  },
  'pane:hello': async (m, s) => {
    if (!s.tab || !(await isSplit(s.tab.id))) return { ok: false };
    await chrome.scripting.executeScript({ target: { tabId: s.tab.id, frameIds: [s.frameId] }, files: PANE_FILES });
    return { ok: true };
  },
  translate: (m, s) => translate(m, s),
  openWelcome: () => chrome.tabs.create({ url: chrome.runtime.getURL('welcome/welcome.html') }).then(() => ({ ok: true })),
  // 引导页「试一试」：打开示例页面，加载完成后直接开启对读
  tryDemo: async (m) => {
    const tab = await chrome.tabs.create({ url: m.url });
    await new Promise((resolve) => {
      const done = () => { chrome.tabs.onUpdated.removeListener(on); clearTimeout(timer); resolve(); };
      const on = (id, info) => { if (id === tab.id && info.status === 'complete') done(); };
      const timer = setTimeout(done, 30000);
      chrome.tabs.onUpdated.addListener(on);
    });
    await toggle(tab.id, {});
    return { ok: true, tabId: tab.id };
  },
  'translate:cancel': (m) => {
    const ac = aborts.get(m.reqId);
    if (ac) ac.abort(new Error('cancelled'));
    return { ok: !!ac };
  },
  openOptions: () => chrome.runtime.openOptionsPage().then(() => ({ ok: true })),
  'cache:clear': (m) => PT.cache.clear(m.scope && m.scope.page ? { page: pageOf(m.scope.page) } : m.scope).then((r) => Object.assign({ ok: true }, r)),
  'cache:count': () => PT.cache.count().then((n) => ({ n })),
  'cache:info': (m) => PT.cache.info(m.host || ''),
  'cache:prune': () => PT.cache.prune({ factor: 0.9 }),
  'usage:get': async () => { await flushUsage(); return (await chrome.storage.local.get('usage')).usage || {}; },
  'usage:reset': async () => { usageAcc.clear(); await chrome.storage.local.remove('usage'); return { ok: true }; },
};

globalThis.PT_handlers = handlers;   // 调试/测试用

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  const h = msg && handlers[msg.type];
  if (!h) return false;
  Promise.resolve()
    .then(() => h(msg, sender))
    .then(sendResponse, (e) => sendResponse({ error: String((e && e.message) || e), code: (e && e.code) || '' }));
  return true;
});
