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
chrome.runtime.onInstalled.addListener(async () => {
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

async function translate(msg) {
  const ac = msg.reqId ? new AbortController() : null;
  if (ac) aborts.set(msg.reqId, ac);
  try { return await translateInner(msg, ac && ac.signal); } finally { if (ac) aborts.delete(msg.reqId); }
}

async function translateInner(msg, signal) {
  const settings = await PT.loadSettings();
  const cfg = msg.cfg || (settings.providers || []).find((p) => p.id === settings.activeProviderId);
  if (!cfg) throw new Error(PT.t('err.noProvider'));
  const impl = PT.providers[cfg.type];
  if (!impl) throw new Error(PT.t('err.unknownType', { type: cfg.type }));
  const ctx = { from: settings.sourceLang || 'auto', to: msg.to || settings.targetLang, page: msg.page || {}, signal };
  const segs = msg.segments || [];
  const results = new Array(segs.length);
  try {
    return await translateCore(msg, cfg, impl, ctx, segs, results, signal);
  } catch (e) {
    const m = String((e && e.message) || e);
    if (!cfg.apiKey && cfg.type !== 'mock' && /HTTP 40[13]/.test(m)) throw new Error(PT.t('err.noKey'));
    throw e;
  }
}

async function translateCore(msg, cfg, impl, ctx, segs, results, signal) {
  const useCache = cfg.type !== 'mock' && !msg.noCache;
  let ks = null;
  if (useCache) {
    ks = await PT.cache.keys([cfg.type, cfg.id, cfg.model || '', ctx.from, ctx.to].join('|'), segs);
    const hit = await PT.cache.getMany(ks);
    hit.forEach((v, i) => { if (typeof v === 'string') results[i] = v; });
  }
  const miss = segs.map((_, i) => i).filter((i) => results[i] === undefined);
  let sentChars = 0;   // 实际发给引擎的字符数（缓存命中不计）
  if (miss.length) {
    const sem = getSem(cfg.id, Math.max(1, cfg.concurrency || 3));
    await Promise.all(chunk(miss, segs, cfg).map((ch) => withSem(sem, async () => {
      if (signal && signal.aborted) throw new Error('cancelled');
      sentChars += ch.reduce((n, i) => n + segs[i].length, 0);
      const out = await impl.translate(ch.map((i) => segs[i]), cfg, ctx);
      if (!Array.isArray(out) || out.length !== ch.length) throw new Error(PT.t('err.count'));
      ch.forEach((i, j) => { results[i] = out[j]; });
      if (useCache) await PT.cache.putMany(ch.map((i) => ks[i]), out);
    })));
  }
  return { results, sentChars };
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
  translate: (m) => translate(m),
  'translate:cancel': (m) => {
    const ac = aborts.get(m.reqId);
    if (ac) ac.abort(new Error('cancelled'));
    return { ok: !!ac };
  },
  openOptions: () => chrome.runtime.openOptionsPage().then(() => ({ ok: true })),
  'cache:clear': () => PT.cache.clear().then(() => ({ ok: true })),
  'cache:count': () => PT.cache.count().then((n) => ({ n })),
};

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  const h = msg && handlers[msg.type];
  if (!h) return false;
  Promise.resolve()
    .then(() => h(msg, sender))
    .then(sendResponse, (e) => sendResponse({ error: String((e && e.message) || e) }));
  return true;
});
