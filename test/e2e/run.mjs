// 端到端测试：Playwright 加载扩展（Chromium 新 headless），在演示页上验证分屏、翻译回填与滚动同步精度。
import { chromium } from 'playwright';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startServer } from './server.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const EXT = resolve(here, '../../extension');
const OUT = join(here, 'out');
mkdirSync(OUT, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let failures = 0;
const check = (ok, msg, extra) => {
  console.log(`${ok ? '  ✔' : '  ✖'} ${msg}${extra !== undefined ? '  ' + JSON.stringify(extra) : ''}`);
  if (!ok) failures++;
};

const srv = await startServer(0);
const BASE = `http://127.0.0.1:${srv.port}`;
const userDir = mkdtempSync(join(tmpdir(), 'st-e2e-'));
const ctx = await chromium.launchPersistentContext(userDir, {
  channel: 'chromium',
  headless: true,
  viewport: { width: 1400, height: 900 },
  args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`],
});
let [sw] = ctx.serviceWorkers();
if (!sw) sw = await ctx.waitForEvent('serviceworker');
// 首次安装会自动打开引导页；本测试不需要它
for (let i = 0; i < 20; i++) {
  const w = ctx.pages().find((p) => p.url().includes('/welcome/welcome.html'));
  if (w) { await w.close(); break; }
  await sleep(150);
}

const setSettings = (patch) => sw.evaluate((p) => globalThis.PT.saveSettings(p), patch);
const toggle = () => sw.evaluate(async () => {
  const tabs = await chrome.tabs.query({});
  const t = tabs.find((x) => x.active) || tabs[0];
  await globalThis.PT_toggleTab(t.id, {});
});

async function panes(page) {
  for (let i = 0; i < 100; i++) {
    const fs = page.frames();
    const L = fs.find((f) => f.name().startsWith('__pt:L:'));
    const R = fs.find((f) => f.name().startsWith('__pt:R:'));
    if (L && R) return { L, R };
    await sleep(100);
  }
  throw new Error('panes not found');
}

// 在窗格主世界里量：滚动状态、焦点线位置、所有 data-idx 块的位置
const probeFn = (sel) => {
  const sc = sel ? document.querySelector(sel) : document.scrollingElement;
  const t = sc.scrollTop, vh = sc.clientHeight, H = sc.scrollHeight, max = H - vh;
  const r = max > 0 ? t / max : 0;
  const vtop = sel ? sc.getBoundingClientRect().top + sc.clientTop : 0;
  const fy = vtop + r * vh;
  const els = [...document.querySelectorAll('[data-idx]')]
    .map((e) => { const b = e.getBoundingClientRect(); return [+e.dataset.idx, b.top, b.bottom]; })
    .filter((x) => x[2] - x[1] > 0);
  return { t, vh, H, max, fy, els, url: location.href };
};
const probe = (frame, sel) => frame.evaluate(probeFn, sel || null);

/** 驱动方焦点线所在段落，在跟随方中应当处于同样的相对位置 */
function alignErr(a, b) {
  const mapB = new Map(b.els.map((e) => [e[0], e]));
  const inA = a.els.find(([i, t, bt]) => t <= a.fy && bt >= a.fy && mapB.has(i));
  if (inA) {
    const eb = mapB.get(inA[0]);
    const frac = (a.fy - inA[1]) / (inA[2] - inA[1]);
    return { idx: inA[0], err: +(eb[1] + frac * (eb[2] - eb[1]) - b.fy).toFixed(2), inBlock: true };
  }
  const next = a.els.filter((e) => e[1] > a.fy && mapB.has(e[0])).sort((x, y) => x[1] - y[1])[0];
  if (!next) return null;
  const eb = mapB.get(next[0]);
  return { idx: next[0], err: +((eb[1] - b.fy) - (next[1] - a.fy)).toFixed(2), inBlock: false };
}

async function settle(L, R, sel) {
  let prev = '';
  for (let i = 0; i < 30; i++) {
    await sleep(200);
    const [a, b] = await Promise.all([probe(L, sel), probe(R, sel)]);
    const sig = `${a.t}|${a.H}|${b.t}|${b.H}`;
    if (sig === prev) return [a, b];
    prev = sig;
  }
  return [await probe(L, sel), await probe(R, sel)];
}

async function wheelAndMeasure(page, L, R, { x, dy, n, sel, driver }) {
  const errs = [];
  for (let i = 0; i < n; i++) {
    await page.mouse.move(x, 500);
    await page.mouse.wheel(0, dy);
    await sleep(120);
    const [a, b] = await settle(L, R, sel);
    const e = driver === 'L' ? alignErr(a, b) : alignErr(b, a);
    if (e) errs.push(e);
  }
  return errs;
}
const summarize = (errs) => {
  const inb = errs.filter((e) => e.inBlock).map((e) => Math.abs(e.err));
  const gap = errs.filter((e) => !e.inBlock).map((e) => Math.abs(e.err));
  // gapMax 仅供参考：焦点线落在两个带编号块之间时，中间可能夹着未编号的译文段（如混排文本串），偏差是正常的
  return { samples: errs.length, inBlockMax: inb.length ? Math.max(...inb) : null, gapMax: gap.length ? Math.max(...gap) : null,
    gapIdx: errs.filter((e) => !e.inBlock && Math.abs(e.err) > 3).map((e) => e.idx) };
};

/* ===================== 1. Mock 引擎 + 普通文章页 ===================== */
console.log('\n[1] article.html + Mock 引擎（译文比原文长约 2 倍）');
await setSettings({ uiLang: 'zh', activeProviderId: 'mock', targetLang: 'zh-CN', highlight: 'hover', syncScroll: true });
const page = await ctx.newPage();
page.on('dialog', (d) => d.accept());   // "全文"按钮会先弹确认框
const consoleErrors = [];
page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()); });
await page.goto(`${BASE}/article.html`);
await page.evaluate(() => window.scrollTo(0, 1800));
await sleep(200);
const origTop = await page.evaluate(() => {
  const els = [...document.querySelectorAll('[data-idx]')].filter((e) => e.getBoundingClientRect().bottom > 60);
  return +els[0].dataset.idx;
});
await toggle();
const { L, R } = await panes(page);
await R.waitForFunction(() => document.body && document.body.innerText.includes('【zh-CN】'), null, { timeout: 15000 });
let [a0, b0] = await settle(L, R);
const lTop = (() => { const e = a0.els.filter((x) => x[2] > 60).sort((p, q) => p[1] - q[1])[0]; return e && e[0]; })();
check(Math.abs(lTop - origTop) <= 1, '左窗格定位到原页面正在读的段落', { origTop, lTop });
check(R.url() === L.url(), '两窗格加载同一 URL');
const e0 = alignErr(a0, b0);
check(e0 && Math.abs(e0.err) <= 3, '打开时右侧已对齐', e0);

const errsL = await wheelAndMeasure(page, L, R, { x: 350, dy: 450, n: 8, driver: 'L' });
const sL = summarize(errsL);
check(sL.inBlockMax !== null && sL.inBlockMax <= 3, '滚左侧：段落内对齐误差 ≤ 3px', sL);

const errsR = await wheelAndMeasure(page, L, R, { x: 1050, dy: -380, n: 6, driver: 'R' });
const sR = summarize(errsR);
check(sR.inBlockMax !== null && sR.inBlockMax <= 3, '滚右侧：左侧反向跟随，误差 ≤ 3px', sR);

// 键盘 End / Home：两侧同时到底 / 到顶
await page.mouse.click(350, 300);
await page.keyboard.press('End');
let [a1, b1] = await settle(L, R);
check(Math.abs(a1.t - a1.max) <= 2 && Math.abs(b1.t - b1.max) <= 2, 'End：两侧同时到底', { L: [a1.t, a1.max], R: [b1.t, b1.max] });
await page.keyboard.press('Home');
[a1, b1] = await settle(L, R);
check(a1.t <= 1 && b1.t <= 1, 'Home：两侧同时到顶', { L: a1.t, R: b1.t });

// 驱动方稳定性：停在中部，触发"全文翻译"（大量译文在视口上下插入），左侧不应被带跑，右侧仍对齐
await page.mouse.move(350, 500);
for (let i = 0; i < 5; i++) { await page.mouse.wheel(0, 500); await sleep(100); }
let [a2, b2] = await settle(L, R);
const tBefore = a2.t;
await page.locator('pt-split-root #all').click();
const allDone = await page.waitForFunction(() => {
  const st = document.querySelector('pt-split-root').shadowRoot.getElementById('status').textContent;
  const m = /已翻译 (\d+)\/(\d+)/.exec(st);
  return m && +m[2] > 50 && m[1] === m[2] && !/请求中/.test(st);
}, null, { timeout: 30000 }).then(() => true, () => false);
check(allDone, '全文翻译完成（状态栏 已翻译 N/N）');
await sleep(800);
[a2, b2] = await settle(L, R);
check(Math.abs(a2.t - tBefore) <= 1, '全文翻译期间左侧(驱动方)位置不被带动', { before: tBefore, after: a2.t });
const e2 = alignErr(a2, b2);
check(e2 && Math.abs(e2.err) <= 3, '全文翻译完成后右侧仍对齐', e2);

// 行内结构保留：链接 / code / 混排文本串
const inline = await R.evaluate(() => {
  const p = [...document.querySelectorAll('p[data-idx]')].find((x) => x.querySelector('a[href^="https://example.com"]'));
  const c = document.querySelector('.comment');
  return {
    linkKept: !!p && !!p.querySelector('a[href^="https://example.com"]') && /\S/.test(p.querySelector('a').textContent),
    codeKept: !!p && p.querySelector('code') && p.querySelector('code').textContent === '<p>',
    runTranslated: !!c && /Movable|Printers|good|width|Early|Responsive|Translators|Line|Hyphenation|Readers|Comparing|Synchronised/.test(c.firstChild.textContent) && c.firstChild.textContent.length > 0,
    runLinkKept: !!c && !!c.querySelector(':scope > a[href*="ycombinator"]'),
    preUntouched: document.querySelector('pre code').textContent.startsWith('function sync(a, b)'),
    lang: document.documentElement.lang,
  };
});
check(inline.linkKept && inline.codeKept, '译文保留行内链接与 <code>', inline);
check(inline.runLinkKept && inline.preUntouched && inline.lang === 'zh-CN', '混排文本串中的链接保留、代码块不翻译、lang 设置', inline);

// 悬停高亮 + 截图
await page.mouse.move(300, 420);
await sleep(300);
await page.screenshot({ path: join(OUT, '1-article-mock.png') });

// 点击 TOC/hash 链接 → 驱动方跳转，右侧跟随
const hashDone = await L.evaluate(() => { const a = document.querySelector('header.top a[href="#s5"]'); return !!a; });
if (hashDone) {
  await page.keyboard.press('Home');
  await settle(L, R);
  const box = await L.locator('header.top a[href="#s5"]').boundingBox();   // 已是主视口坐标
  await page.mouse.click(box.x + 5, box.y + 5);
  const [a3, b3] = await settle(L, R);
  const e3 = alignErr(a3, b3);
  check(e3 && Math.abs(e3.err) <= 3 && a3.t > 1000 && L.url().endsWith('#s5'), '点击页内锚点(#s5)跳转后右侧跟随', { ...e3, t: a3.t });
}

// 关闭：原页面回到左窗格当前阅读段落
await page.mouse.move(350, 500);
for (let i = 0; i < 3; i++) { await page.mouse.wheel(0, 300); await sleep(80); }
const [a4] = await settle(L, R);
const readIdx = (() => { const e = a4.els.filter((x) => x[2] > 60).sort((p, q) => p[1] - q[1])[0]; return e && e[0]; })();
await page.locator('pt-split-root #close').click();
await sleep(500);
const after = await page.evaluate(() => ({
  overlay: !!document.querySelector('pt-split-root'),
  top: +[...document.querySelectorAll('[data-idx]')].filter((e) => e.getBoundingClientRect().bottom > 60)[0].dataset.idx,
}));
check(!after.overlay && Math.abs(after.top - readIdx) <= 1, '关闭后移除分屏，原页面停在当前阅读段落', { readIdx, ...after });
check(consoleErrors.length === 0, '顶层页面无 console error', consoleErrors.slice(0, 3));

/* ===================== 2. 禁止嵌入的页面（XFO: DENY） ===================== */
console.log('\n[2] deny.html（X-Frame-Options: DENY + frame-ancestors none）');
await page.goto(`${BASE}/deny.html`);
await toggle();
{
  const p2 = await panes(page);
  const ok = await p2.R.waitForFunction(() => document.body && document.body.innerText.includes('【zh-CN】'), null, { timeout: 15000 }).then(() => true, () => false);
  check(ok, 'DNR 临时去掉响应头后，窗格可以加载并翻译');
  await page.locator('pt-split-root #close').click();
  await sleep(300);
  const rules = await sw.evaluate(() => chrome.declarativeNetRequest.getSessionRules());
  check(rules.length === 0, '关闭分屏后 DNR 会话规则已清除', rules.length);
}

/* ===================== 3. 内部滚动容器布局 ===================== */
console.log('\n[3] inner-scroll.html（window 不滚动，<main> 内部滚动）');
await page.goto(`${BASE}/inner-scroll.html`);
await toggle();
{
  const { L: L3, R: R3 } = await panes(page);
  await R3.waitForFunction(() => document.body && document.body.innerText.includes('【zh-CN】'), null, { timeout: 15000 });
  await settle(L3, R3, 'main.scroll');
  const errs = await wheelAndMeasure(page, L3, R3, { x: 450, dy: 500, n: 6, sel: 'main.scroll', driver: 'L' });
  const s3 = summarize(errs);
  check(s3.inBlockMax !== null && s3.inBlockMax <= 3, '内部滚动容器：对齐误差 ≤ 3px', s3);
  await page.screenshot({ path: join(OUT, '3-inner-scroll.png') });
  await page.locator('pt-split-root #close').click();
}

/* ===================== 4. OpenAI 兼容引擎（本地假服务） + 导航跟随 ===================== */
console.log('\n[4] OpenAI 兼容引擎（假服务：返回 <think> + ```json 包裹，译文比原文短）');
await sw.evaluate(async (base) => {
  const s = await globalThis.PT.loadSettings();
  const providers = s.providers.filter((p) => p.id !== 'fake').concat([{
    id: 'fake', type: 'openai', name: 'fake', baseUrl: base + '/v1', apiKey: 'sk-test', model: 'fake-model',
    temperature: 0.2, extraBody: '{"chat_template_kwargs":{"enable_thinking":false}}', batchChars: 1500, batchSize: 12, concurrency: 3, timeoutMs: 10000,
  }]);
  await globalThis.PT.saveSettings({ providers, activeProviderId: 'fake' });
}, BASE);
await page.goto(`${BASE}/article.html`);
await toggle();
{
  const { L: L4, R: R4 } = await panes(page);
  await R4.waitForFunction(() => document.body && document.body.innerText.includes('译:'), null, { timeout: 15000 });
  await settle(L4, R4);
  const errs = await wheelAndMeasure(page, L4, R4, { x: 350, dy: 500, n: 5, driver: 'L' });
  const s4 = summarize(errs);
  check(s4.inBlockMax !== null && s4.inBlockMax <= 3, '译文比原文短时同样对齐', s4);
  const reqs = await (await fetch(`${BASE}/__requests`)).json();
  const r0 = reqs[0];
  check(r0 && r0.model === 'fake-model' && r0.temperature === 0.2 && r0.chat_template_kwargs && r0.chat_template_kwargs.enable_thinking === false,
    '请求体：model / temperature / extraBody 合并正确');
  check(r0 && /JSON array/.test(r0.messages[0].content) && Array.isArray(JSON.parse(r0.messages[1].content)), '批量请求使用 JSON 数组协议', reqs.length);
  const tagged = reqs.flatMap((r) => (r.messages[1].content.startsWith('[') ? JSON.parse(r.messages[1].content) : [r.messages[1].content])).find((s) => /<g\d+>/.test(s));
  check(!!tagged, '行内格式以 <gN>/<xN/> 占位标签发送', tagged && tagged.slice(0, 120));
  const sentSegs = reqs.flatMap((r) => (r.messages[1].content.startsWith('[') ? JSON.parse(r.messages[1].content) : [r.messages[1].content]));
  check(!sentSegs.some((s) => /[\u4e00-\u9fff]{4,}/.test(s)), '已是中文的段落（lang 属性 / 文字脚本）不发送给引擎', sentSegs.length);
  const linkOk = await R4.evaluate(() => {
    const p = [...document.querySelectorAll('p[data-idx]')].find((x) => x.querySelector('a[href^="https://example.com"]'));
    return !!p && p.textContent.startsWith('译:') && !!p.querySelector('code');
  });
  check(linkOk, '解析 <think>/代码块包裹后正确回填，链接与 code 保留');
  await page.screenshot({ path: join(OUT, '4-openai-fake.png') });

  // 导航跟随：在左侧点击跳到另一页面，右侧应跟随
  const box = await L4.locator('#nav-inner').boundingBox();
  await page.mouse.click(box.x + 5, box.y + 5);
  const p5 = await (async () => { for (let i = 0; i < 50; i++) { await sleep(200); const f = await panes(page); if (f.R.url().endsWith('/inner-scroll.html') && f.L.url().endsWith('/inner-scroll.html')) return f; } return null; })();
  check(!!p5, '左侧点链接换页 → 右侧跟随到同一页面');
  check(page.url().endsWith('/inner-scroll.html'), '地址栏同步为当前页面（同源时 replaceState）', page.url());
}

/* ===================== 5. 按需翻译 / 成本控制 ===================== */
console.log('\n[5] 按需翻译：只翻可视区域、滚动中不发请求、划远后取消在途请求（假服务延迟 2.5s）');
await sw.evaluate(async (base) => {
  const s = await globalThis.PT.loadSettings();
  const providers = s.providers.filter((p) => p.id !== 'slow').concat([{
    id: 'slow', type: 'openai', name: 'slow', baseUrl: base + '/slow/v1', apiKey: '', model: 'slow-model',
    temperature: '', extraBody: '', batchChars: 1500, batchSize: 20, concurrency: 3, timeoutMs: 20000,
  }]);
  await globalThis.PT.saveSettings({ providers, activeProviderId: 'slow', prefetchScreens: 0.5 });
}, BASE);
{
  const stat = async () => (await fetch(`${BASE}/__stats`)).json();
  await page.goto(`${BASE}/article.html`);
  const s0 = await stat();
  await toggle();
  const { L: L5, R: R5 } = await panes(page);
  await sleep(1500);                                   // 首屏请求已发出，仍在"生成"
  // 首屏（含预取区）里的段落：流式下其中一部分可能在划走前已经到达并显示，这是允许的
  const firstScreen = new Set(await R5.evaluate(() => [...document.querySelectorAll('[data-idx]')]
    .filter((e) => e.getBoundingClientRect().top < innerHeight * 1.6).map((e) => +e.dataset.idx)));
  const s1 = await stat();
  check(s1.requests > s0.requests, '打开后立即请求首屏', { 请求数: s1.requests - s0.requests, 段数: s1.segs - s0.segs });
  await page.mouse.move(350, 500);
  for (let i = 0; i < 14; i++) { await page.mouse.wheel(0, 600); await sleep(60); }   // 快速一路划下去
  const s2 = await stat();
  check(s2.requests === s1.requests, '快速滚动过程中不发新请求', { 滚动中新增请求: s2.requests - s1.requests });
  await sleep(4500);                                   // 停下 → 只翻当前位置
  const s3 = await stat();
  check(s3.aborted - s0.aborted >= 1, '划远后，首屏在途请求被取消（服务端连接中断）', { 取消: s3.aborted - s0.aborted });
  const info = await R5.evaluate(() => {
    const vh = innerHeight;
    const els = [...document.querySelectorAll('[data-idx]')].map((e) => {
      const r = e.getBoundingClientRect();
      return { idx: +e.dataset.idx, top: Math.round(r.top), bottom: Math.round(r.bottom), tr: e.textContent.startsWith('译:') };
    }).filter((x) => x.bottom > x.top);
    return { vh, total: els.length, translated: els.filter((x) => x.tr), visibleUntranslated: els.filter((x) => x.bottom > 60 && x.top < vh && !x.tr).map((x) => x.idx) };
  });
  check(info.visibleUntranslated.length === 0, '停下后当前可视区域已翻译', info.visibleUntranslated);
  const far = info.translated.filter((x) => (x.top < -0.6 * info.vh || x.top > 1.9 * info.vh) && !firstScreen.has(x.idx));
  check(far.length === 0, '只翻译了可视区域附近的段落（划过的中段没有翻译）', { 已译: info.translated.length, 全部: info.total, 远处已译: far.map((x) => x.idx) });
  check(s3.segs - s0.segs < info.total * 0.5, '发送的段数远少于全文', { 发送段数: s3.segs - s0.segs, 页面段数: info.total });
  // 回到顶部：被取消的首屏会重新翻译
  await page.keyboard.press('Home');
  await sleep(4500);
  const top = await R5.evaluate(() => [...document.querySelectorAll('[data-idx]')]
    .filter((e) => { const r = e.getBoundingClientRect(); return r.bottom > 60 && r.top < innerHeight && r.height > 0 && !/[\u4e00-\u9fff]{4,}/.test(e.textContent.replace(/^译:.*/, '')); })
    .filter((e) => !e.textContent.startsWith('译:')).map((e) => +e.dataset.idx));
  check(top.length === 0, '回到顶部后，之前被取消的首屏重新翻译', top);
  await page.screenshot({ path: join(OUT, '5-on-demand.png') });
}

/* ===================== 6. 流式与"正在翻译"提示 ===================== */
console.log('\n[6] 流式：翻好一段显示一段 + 正在翻译提示（假服务每段 400ms）');
await sw.evaluate(async (base) => {
  const s = await globalThis.PT.loadSettings();
  const providers = s.providers.filter((p) => p.id !== 'drip').concat([{
    id: 'drip', type: 'openai', name: 'drip', baseUrl: base + '/drip/v1', apiKey: '', model: 'drip-model',
    temperature: '', extraBody: '', batchChars: 6000, batchSize: 40, concurrency: 1, timeoutMs: 20000,
  }]);
  await globalThis.PT.saveSettings({ providers, activeProviderId: 'drip', prefetchScreens: 0 });
}, BASE);
{
  await page.goto(`${BASE}/article.html`);
  await toggle();
  const { R: R6 } = await panes(page);
  const t0 = Date.now();
  const firstSeen = new Map();
  let sawPending = false, sawBusy = false;
  while (Date.now() - t0 < 15000) {
    const snap = await R6.evaluate(() => ({
      tr: [...document.querySelectorAll('[data-idx]')]
        .filter((e) => { const r = e.getBoundingClientRect(); return r.bottom > 60 && r.top < innerHeight && r.height > 0; })
        .map((e) => [+e.dataset.idx, e.textContent.startsWith('译:')]),
      pending: document.getAnimations().filter((a) => a.effect && a.effect.getTiming().iterations === Infinity).length,
    })).catch(() => null);
    if (snap) {
      for (const [i, ok] of snap.tr) if (ok && !firstSeen.has(i)) firstSeen.set(i, Date.now() - t0);
      if (snap.pending) sawPending = true;
    }
    if (await page.evaluate(() => { const b = document.querySelector('pt-split-root')?.shadowRoot.getElementById('busy'); return !!b && !b.hidden; })) sawBusy = true;
    if (snap && snap.tr.length && snap.tr.every((x) => x[1])) break;
    await sleep(100);
  }
  const times = [...firstSeen.values()].sort((a, b) => a - b);
  check(times.length >= 3 && times[times.length - 1] - times[0] >= 800, '同一批译文逐段出现（流式），不是整批一起出现', { 首段ms: times[0], 末段ms: times[times.length - 1], 段数: times.length });
  check(sawPending, '翻译中的段落有呼吸提示动画');
  check(sawBusy, '顶栏显示"请求中"转圈');
  await sleep(600);
  const left = await R6.evaluate(() => document.getAnimations().filter((a) => a.effect && a.effect.getTiming().iterations === Infinity).length);
  check(left === 0, '翻译完成后提示动画全部清除', left);
  await page.screenshot({ path: join(OUT, '6-streaming.png') });
}

/* ===================== 7. 页面自己改写已翻译的文字：不能死循环重译 ===================== */
console.log('\n[7] 页面反复改写译文（框架重渲染 / 追加文字）：不死循环、不烧钱');
await sw.evaluate(async () => {
  await globalThis.PT.saveSettings({ activeProviderId: 'fake', prefetchScreens: 0.5 });
  await globalThis.PT.cache.clear();
});
{
  const s0 = await (await fetch(`${BASE}/__stats`)).json();
  await page.goto(`${BASE}/rerender.html`);
  await toggle();
  const { R: R7 } = await panes(page);
  await sleep(14000);   // 页面改写 12 秒
  const s1 = await (await fetch(`${BASE}/__stats`)).json();
  const info = await R7.evaluate(() => ({
    restore: document.getElementById('restore').textContent,
    append: document.getElementById('append').textContent,
    quiet: document.querySelector('[data-idx="3"]').textContent,
  }));
  const segs = s1.segs - s0.segs;
  check(segs <= 4 + 2 + 1, '改写引起的重译有上限（不随改写次数增长）', { 发送段数: segs, 页面改写次数: 12 });
  check((info.append.match(/译:/g) || []).length <= 1 && info.append.length < 400, '追加文字的段落不会被反复叠加翻译', info.append.slice(0, 120));
  check(info.quiet.startsWith('译:') && (info.quiet.match(/译:/g) || []).length === 1, '未被改写的段落只翻译一次', info.quiet.slice(0, 60));
}

await ctx.close();
srv.close();
rmSync(userDir, { recursive: true, force: true });
console.log(failures ? `\n${failures} 项失败` : '\n全部通过');
process.exit(failures ? 1 : 0);
