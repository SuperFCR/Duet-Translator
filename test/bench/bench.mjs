// bench.mjs — 按需翻译的成本 / 速度基准。Playwright 加载扩展，deepseek 预设指向模拟 LLM（llm-sim.mjs）。
//
//   cd test && node bench/bench.mjs
//   EXT_DIR=/tmp/duet-base/extension BENCH_LABEL=baseline node bench/bench.mjs
//
// 环境变量（详见 README.md）：
//   EXT_DIR           扩展目录（默认 ../../extension，相对本文件；给出时相对当前目录）
//   BENCH_LABEL       结果名 → out/<label>.json
//   BENCH_OVERRIDES   JSON，合并进 deepseek 引擎配置，如 '{"batchChars":800,"concurrency":6}'
//   BENCH_SETTINGS    JSON，合并进全局设置，如 '{"prefetchScreens":1}'
//   BENCH_SCENARIOS   逗号分隔，默认 read,revisit,skim,forum；另有 jump（A→B→C 跳读）
//   BENCH_READ_STEPS  read / forum 的滚动次数（默认 12）；BENCH_DWELL_MS 每步停留（默认 3500）
//   BENCH_CAP_MS      等待上限（默认 15000）；BENCH_HEADED=1 有界面运行（需要显示器）
//   SIM_*             模拟器参数（见 llm-sim.mjs 的 ENV_MAP）
import { chromium } from 'playwright';
import http from 'node:http';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startSim } from './llm-sim.mjs';
import { writeForum } from './gen-forum.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const REPO_EXT = resolve(here, '../../extension');
const EXT = process.env.EXT_DIR ? resolve(process.cwd(), process.env.EXT_DIR) : REPO_EXT;
const LABEL = process.env.BENCH_LABEL || (EXT === REPO_EXT ? 'current' : basename(dirname(EXT)));
const OVERRIDES = JSON.parse(process.env.BENCH_OVERRIDES || '{}');
const SETTINGS = JSON.parse(process.env.BENCH_SETTINGS || '{}');
const SCENARIOS = (process.env.BENCH_SCENARIOS || 'read,revisit,skim,forum').split(',').map((s) => s.trim()).filter(Boolean);
const READ_STEPS = +process.env.BENCH_READ_STEPS || 12;
const DWELL = +process.env.BENCH_DWELL_MS || 3500;
const JUMP_DWELL = +process.env.BENCH_JUMP_DWELL_MS || 800;   // jump 场景在 B 停留的时间
const CAP = +process.env.BENCH_CAP_MS || 15000;
const WATCHDOG = +process.env.BENCH_TIMEOUT_MS || 8 * 60 * 1000;
const OUT = join(here, 'out');
const SEL = 'p,li,h1,h2,h3,h4,h5,h6,td,dd,blockquote,dt,figcaption';
const PANE_X = 350, PANE_Y = 500;     // 左窗格中部（视口 1400×900，左右各约一半）

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sleepUntil = (t) => sleep(Math.max(0, t - Date.now()));
const log = (...a) => console.log(...a);

if (!existsSync(join(EXT, 'manifest.json'))) { console.error(`EXT_DIR has no manifest.json: ${EXT}`); process.exit(2); }

/* ------------------------------ 环境 / 服务 ------------------------------ */
// 本机 WSL 的 Chromium 缺系统 NSS 库：自动补上本地解包的库（已设置 LD_LIBRARY_PATH 时不动）
const browserEnv = Object.assign({}, process.env);
{
  const libRoot = join(homedir(), '.cache/st-e2e-libs');
  const lib = join(libRoot, 'root/usr/lib/x86_64-linux-gnu');
  if (!browserEnv.LD_LIBRARY_PATH && existsSync(lib)) browserEnv.LD_LIBRARY_PATH = `${lib}:${lib}/nss`;
  if (!browserEnv.FONTCONFIG_FILE && existsSync(join(libRoot, 'fonts.conf'))) browserEnv.FONTCONFIG_FILE = join(libRoot, 'fonts.conf');
}

function startPages() {
  const dirs = [join(here, 'pages'), join(here, '../demo')];
  const server = http.createServer((req, res) => {
    const p = new URL(req.url, 'http://x').pathname;
    if (p === '/favicon.ico') { res.writeHead(204); return res.end(); }
    const rel = (p === '/' ? '/article.html' : p).replace(/\.\./g, '');
    for (const d of dirs) {
      let buf;
      try { buf = readFileSync(join(d, rel)); } catch (_) { continue; }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      return res.end(buf);
    }
    res.writeHead(404); res.end('not found');
  });
  return new Promise((r) => server.listen(0, '127.0.0.1', () => r({
    base: `http://127.0.0.1:${server.address().port}`,
    close: () => new Promise((d) => { server.closeAllConnections?.(); server.close(() => d()); }),
  })));
}

if (!existsSync(join(here, '../demo/article.html'))) execFileSync(process.execPath, [join(here, '../demo/gen.mjs')]);
if (!existsSync(join(here, 'pages/forum.html'))) writeForum();

const pages = await startPages();
const sim = await startSim({ port: +process.env.SIM_PORT || 0 });
const ARTICLE = `${pages.base}/article.html`;
const FORUM = `${pages.base}/forum.html`;

/* ------------------------------ 浏览器（每组场景一个全新 profile） ------------------------------ */
let browser = null;   // { ctx, userDir }
const userDirs = [];
let effective = null; // 实际生效的引擎配置与设置

async function closeBrowser() {
  if (!browser) return;
  const b = browser; browser = null;
  await b.ctx.close().catch(() => {});
}

async function launch() {
  await closeBrowser();
  const userDir = mkdtempSync(join(tmpdir(), 'duet-bench-'));
  userDirs.push(userDir);
  const ctx = await chromium.launchPersistentContext(userDir, {
    channel: 'chromium',
    headless: !process.env.BENCH_HEADED,
    viewport: { width: 1400, height: 900 },
    env: browserEnv,
    args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`],
  });
  browser = { ctx, userDir };
  let sw = ctx.serviceWorkers()[0];
  if (!sw) sw = await ctx.waitForEvent('serviceworker', { timeout: 15000 });
  // 首次安装会打开引导页（onInstalled 里先写入猜测的目标语言）；等它出现再写设置，避免被覆盖
  for (let i = 0; i < 30; i++) {
    const w = ctx.pages().find((p) => p.url().includes('/welcome/'));
    if (w) { await w.close().catch(() => {}); break; }
    await sleep(150);
  }
  for (let attempt = 0; attempt < 3; attempt++) {
    effective = await swEval(async ({ base, overrides, patch }) => {
      const PT = globalThis.PT;
      const s = await PT.loadSettings();
      const preset = s.providers.find((p) => p.id === 'deepseek');
      if (!preset) throw new Error('no "deepseek" provider preset in this extension version');
      const presetDefaults = JSON.parse(JSON.stringify(preset));
      const providers = s.providers.map((p) => (p.id === 'deepseek' ? Object.assign({}, p, { baseUrl: base, apiKey: 'sk-sim' }, overrides) : p));
      await PT.saveSettings(Object.assign({ providers, activeProviderId: 'deepseek', targetLang: 'zh-CN', uiLang: 'en' }, patch));
      const s2 = await PT.loadSettings();
      const prov = Object.assign({}, s2.providers.find((p) => p.id === 'deepseek'));
      delete presetDefaults.apiKey; delete prov.apiKey;
      const settings = Object.assign({}, s2); delete settings.providers;
      return { presetDefaults, provider: prov, settings };
    }, { base: sim.url, overrides: OVERRIDES, patch: SETTINGS });
    await sleep(300);
    const ok = await swEval(async (base) => {
      const s = await globalThis.PT.loadSettings();
      const p = s.providers.find((x) => x.id === 'deepseek');
      return s.targetLang === 'zh-CN' && s.activeProviderId === 'deepseek' && p && p.baseUrl === base;
    }, sim.url);
    if (ok) return;
  }
  throw new Error('could not apply bench settings');
}

async function liveSw() {
  const ws = browser.ctx.serviceWorkers().filter((w) => w.url().startsWith('chrome-extension://'));
  if (ws.length) return ws[ws.length - 1];
  return browser.ctx.waitForEvent('serviceworker', { timeout: 10000 });
}
async function swEval(fn, arg) { return (await liveSw()).evaluate(fn, arg); }

/* ------------------------------ 窗格 / 测量 ------------------------------ */
const CJK_SRC = '[\\p{Script=Han}\\p{Script=Hiragana}\\p{Script=Katakana}\\p{Script=Hangul}]';

// 左窗格（原文，不会被改动）：哪些块需要翻译 = ≥15 个字母且不含中日韩文字
const needsFn = ({ SEL, CJK_SRC }) => {
  const CJK = new RegExp(CJK_SRC, 'u');
  return [...document.querySelectorAll(SEL)].map((e) => {
    const t = e.textContent || '';
    return (t.match(/\p{L}/gu) || []).length >= 15 && !CJK.test(t) ? 1 : 0;
  });
};
// 右窗格：可见（与视口相交）的待翻译块里，有多少还没出现中文
const probeFn = ({ SEL, CJK_SRC, needs }) => {
  const CJK = new RegExp(CJK_SRC, 'u');
  const els = document.querySelectorAll(SEL);
  const same = els.length === needs.length;
  const vh = window.innerHeight;
  let vis = 0, pending = 0, anyTr = 0;
  for (let i = 0; i < els.length; i++) {
    const e = els[i];
    const t = e.textContent || '';
    const tr = CJK.test(t);
    const need = same ? needs[i] === 1 : (tr || (t.match(/[A-Za-z]/g) || []).length >= 15);   // 结构不一致时的退化判断
    if (!need) continue;
    if (tr) anyTr++;
    const r = e.getBoundingClientRect();
    if (r.width < 1 || r.height < 1 || r.bottom <= 0 || r.top >= vh) continue;
    vis++;
    if (!tr) pending++;
  }
  const se = document.scrollingElement || document.documentElement;
  return { y: Math.round(window.scrollY), H: se.scrollHeight, vh: se.clientHeight, vis, pending, anyTr, same };
};

async function panes(page) {
  for (let i = 0; i < 150; i++) {
    const fs = page.frames();
    const L = fs.find((f) => f.name().startsWith('__pt:L:'));
    const R = fs.find((f) => f.name().startsWith('__pt:R:'));
    if (L && R) return { L, R };
    await sleep(80);
  }
  throw new Error('split panes not found');
}

async function toggleFor(page) {
  await page.bringToFront().catch(() => {});
  await swEval(async (url) => {
    const tabs = await chrome.tabs.query({});
    const t = tabs.filter((x) => x.url === url).sort((a, b) => b.id - a.id)[0] || tabs.find((x) => x.active) || tabs[0];
    await globalThis.PT_toggleTab(t.id, {});
  }, page.url());
}

/** 新标签页打开 url 并开启分屏（关闭其他标签页）；返回会话与"开始开启"的时刻 */
async function openSplit(url) {
  const page = await browser.ctx.newPage();
  for (const p of browser.ctx.pages()) if (p !== page) await p.close().catch(() => {});
  page.on('dialog', (d) => d.accept().catch(() => {}));
  if (process.env.BENCH_CONSOLE) page.on('console', (m) => { const t = m.text(); if (t.startsWith('[dbg]')) log('   ' + t); });
  await page.goto(url, { waitUntil: 'load' });
  const tToggle = Date.now();
  await toggleFor(page);
  const { L, R } = await panes(page);
  const paneMs = Date.now() - tToggle;
  await L.waitForFunction(() => document.readyState !== 'loading', null, { timeout: 15000 });
  const needs = await L.evaluate(needsFn, { SEL, CJK_SRC });
  const s = { page, L, R, needs, tToggle, paneMs };
  s.probe = () => s.R.evaluate(probeFn, { SEL, CJK_SRC, needs }).catch(() => null);
  return s;
}

/** 打开后：首个译文块出现时间、首屏全部译完时间（相对开启分屏） */
async function measureOpen(s, maxMs = CAP) {
  let first = null, full = null;
  while (Date.now() - s.tToggle < maxMs) {
    const p = await s.probe();
    const t = Date.now() - s.tToggle;
    if (p) {
      if (first == null && p.anyTr > 0) first = t;
      if (full == null && p.vis > 0 && p.pending === 0) full = t;
      if (first != null && full != null) break;
    }
    await sleep(50);
  }
  return { first, full };
}

/**
 * 一次滚动停下后的等待：先等右窗格滚动位置稳定（停下的时刻），
 * 再等可见的待翻译块全部出现中文；上限 CAP。y0 = 滚动前位置。
 */
async function measureStop(s, y0) {
  const tA = Date.now();
  let prev = null, prevT = 0, tStop = null, p = null, pT = 0;
  for (;;) {
    p = await s.probe(); pT = Date.now();
    if (p) {
      const moved = p.y !== y0 || pT - tA > 700;          // 到底/到顶滚不动时 700ms 后视为已停
      if (prev && moved && p.y === prev.y) { tStop = prevT; break; }
      prev = p; prevT = pT;
    }
    if (pT - tA > 4000) { tStop = pT; prev = null; break; }
    await sleep(60);
  }
  if (prev && prev.pending === 0) return { wait: 0, tStop, y: prev.y, capped: false };
  for (;;) {
    if (p && p.pending === 0) return { wait: pT - tStop, tStop, y: p.y, capped: false };
    if (Date.now() - tStop >= CAP) return { wait: CAP, tStop, y: p ? p.y : null, capped: true };
    await sleep(60);
    p = await s.probe(); pT = Date.now();
  }
}

async function wheel(s, dy, n = 1, gap = 60) {
  await s.page.mouse.move(PANE_X, PANE_Y);
  for (let i = 0; i < n; i++) {
    await s.page.mouse.wheel(0, dy);
    if (i < n - 1) await sleep(gap);
  }
}

/** 慢速阅读：每 DWELL 下滑 0.4 屏；没翻完就等到翻完（上限 CAP）再继续 */
async function readSteps(s, n) {
  const waits = [];
  for (let i = 0; i < n; i++) {
    const p0 = await s.probe();
    const tW = Date.now();
    await wheel(s, Math.round(0.4 * ((p0 && p0.vh) || 860)));
    const m = await measureStop(s, p0 ? p0.y : null);
    waits.push(m);
    await sleepUntil(tW + DWELL);
  }
  return waits;
}

/** 场景结束：等模拟器上没有在途请求（连续 600ms），最多 10s */
async function quiesce(maxMs = 10000) {
  const t0 = Date.now();
  let idle = null;
  while (Date.now() - t0 < maxMs) {
    if (sim.activeCount() === 0) { idle = idle || Date.now(); if (Date.now() - idle >= 600) return true; } else idle = null;
    await sleep(100);
  }
  return false;
}

async function shellStatus(s) {
  return s.page.evaluate(() => {
    const r = document.querySelector('pt-split-root');
    const el = r && r.shadowRoot && r.shadowRoot.getElementById('status');
    return el ? { text: el.textContent, err: el.classList.contains('err') } : null;
  }).catch(() => null);
}

/* ------------------------------ 指标 ------------------------------ */
const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : null);
const pct = (a, q) => { if (!a.length) return null; const v = [...a].sort((x, y) => x - y); return v[Math.min(v.length - 1, Math.ceil(q * v.length) - 1)]; };

function collect(name, { s, open, stops = [], status, quiet }) {
  const entries = sim.log.slice();
  const st = sim.stats(entries);
  const seen = new Set();
  let dup = 0;
  for (const e of entries) for (const h of e.segs) { if (seen.has(h)) dup++; else seen.add(h); }
  const waits = stops.map((x) => x.wait);
  return {
    name,
    requests: st.requests, aborted: st.aborted, errors: st.errors,
    segs: st.nSegs, uniqSegs: seen.size, dupSegs: dup,
    inTok: st.inTok, missTok: st.missTok, hitTok: st.cachedTok, outTok: st.outTok, outTokAborted: st.outTokAborted,
    cost: st.cost,
    ttfFirst: open ? open.first : null, openFull: open ? open.full : null, paneMs: s ? s.paneMs : null,
    firstReqMs: s && entries[0] ? entries[0].t0 - s.tToggle : null,
    stops: waits.length, waitMean: mean(waits), waitP90: pct(waits, 0.9), waitMax: waits.length ? Math.max(...waits) : null,
    zeroWaits: waits.filter((w) => w === 0).length, capped: stops.filter((x) => x.capped).length,
    waits, status, quiesced: quiet,
    log: entries.map((e) => ({ t: s ? e.t0 - s.tToggle : null, ttfb: e.ttfb, dur: e.tEnd != null ? e.tEnd - e.t0 : null,
      aborted: e.aborted, status: e.status, nSegs: e.nSegs, inTok: e.inTok, cachedTok: e.cachedTok, outTok: e.outTok,
      maxTokens: e.maxTokens, finish: e.finish, stream: e.stream, ...(e.texts ? { texts: e.texts } : {}) })),
  };
}

/* ------------------------------ 场景 ------------------------------ */
const results = {};
let readSession = null;

async function scnRead(name, url, steps = READ_STEPS) {
  await launch();                                   // 冷启动：全新 profile（扩展缓存为空）
  sim.reset();
  const s = await openSplit(url);
  const open = await measureOpen(s);
  await sleepUntil(s.tToggle + DWELL);
  const stops = await readSteps(s, steps);
  const quiet = await quiesce();
  return { s, m: collect(name, { s, open, stops, status: await shellStatus(s), quiet }) };
}

const scenarios = {
  async read() {
    const { s, m } = await scnRead('read', ARTICLE);
    readSession = s;
    return m;
  },
  async revisit() {
    if (!readSession) { log('  (revisit: running an unmeasured read first)'); readSession = (await scnRead('read-warmup', ARTICLE)).s; }
    sim.reset();
    const old = readSession;
    readSession = null;
    await old.page.locator('pt-split-root #close').click({ timeout: 3000 }).catch(() => toggleFor(old.page));
    await sleep(300);
    const s = await openSplit(ARTICLE);             // 新标签页，同一 profile（扩展缓存保留）
    const open = await measureOpen(s);
    await sleepUntil(s.tToggle + DWELL);
    const stops = await readSteps(s, 4);
    const quiet = await quiesce();
    return collect('revisit', { s, open, stops, status: await shellStatus(s), quiet });
  },
  async skim() {
    await launch();
    readSession = null;
    sim.reset();
    const s = await openSplit(ARTICLE);
    const open = await measureOpen(s, 1500);        // 打开 1.5s 后就开始快速划
    await sleepUntil(s.tToggle + 1500);
    const stops = [];
    for (const dir of [1, -1]) {
      const p0 = await s.probe();
      const dist = dir > 0 ? (p0.H - p0.vh - p0.y) : p0.y;
      const n = Math.min(30, Math.max(3, Math.ceil(dist / 600) + 2));
      await wheel(s, 600 * dir, n, 60);
      const m = await measureStop(s, p0.y);
      stops.push(m);
      await sleepUntil(Math.max(m.tStop + 4000, Date.now()));
    }
    const quiet = await quiesce();
    return collect('skim', { s, open, stops, status: await shellStatus(s), quiet });
  },
  // 跳读：在 A 停一下（请求已发出）→ 迅速跳到 B 停一下 → 再跳到离 B 约 1.3 屏的 C，测 C 整屏翻完要等多久（两轮）
  async jump() {
    await launch();
    readSession = null;
    sim.reset();
    const s = await openSplit(ARTICLE);
    const open = await measureOpen(s, 1000);
    await sleepUntil(s.tToggle + 1000);
    const stops = [];
    const hop = async (screens) => {
      const p0 = await s.probe();
      const dy = Math.round(screens * ((p0 && p0.vh) || 860));
      const n = Math.max(1, Math.ceil(Math.abs(dy) / 600));
      await wheel(s, Math.round(dy / n), n, 40);
      return measureStop(s, p0 ? p0.y : null);
    };
    for (let round = 0; round < 2; round++) {
      const mB = await hop(3);                       // A → B
      await sleepUntil(mB.tStop + JUMP_DWELL);
      const mC = await hop(1.3);                     // B → C（在旧规则的"远处"范围内，B 的请求不会被取消）
      stops.push(mC);
      await sleepUntil(Math.max(mC.tStop + 1500, Date.now()));
    }
    const quiet = await quiesce();
    return collect('jump', { s, open, stops, status: await shellStatus(s), quiet });
  },
  async forum() {
    readSession = null;
    const { s, m } = await scnRead('forum', FORUM);
    return m;
  },
};

/* ------------------------------ 运行 ------------------------------ */
function gitInfo(dir) {
  try {
    const commit = execFileSync('git', ['-C', dir, 'rev-parse', '--short', 'HEAD'], { encoding: 'utf8' }).trim();
    const dirty = execFileSync('git', ['-C', dir, 'status', '--porcelain', '--', '.'], { encoding: 'utf8' }).trim().length > 0;
    return { commit, dirty };
  } catch (_) { return null; }
}

const fmtN = (v, d = 0) => (v == null ? '–' : (+v).toFixed(d));
const fmtCost = (v) => (v == null ? '–' : '$' + v.toFixed(6));
function table(rows) {
  const head = '| scenario | req | abort | segs (dup) | in miss | in hit | out (aborted) | cost | first tr ms | 1st screen ms | wait mean ms | wait p90 ms | capped |';
  const sep = '|' + head.split('|').slice(1, -1).map(() => '---').join('|') + '|';
  const lines = rows.map((r) => `| ${r.name} | ${r.requests} | ${r.aborted} | ${r.segs} (${r.dupSegs}) | ${r.missTok} | ${r.hitTok} | ${r.outTok} (${r.outTokAborted}) | ${fmtCost(r.cost)} | ${fmtN(r.ttfFirst)} | ${fmtN(r.openFull)} | ${fmtN(r.waitMean)} | ${fmtN(r.waitP90)} | ${r.capped ?? '–'}/${r.stops ?? '–'} |`);
  return [head, sep, ...lines].join('\n');
}

function total(list) {
  const t = { name: 'TOTAL', requests: 0, aborted: 0, errors: 0, segs: 0, uniqSegs: null, dupSegs: 0, inTok: 0, missTok: 0, hitTok: 0, outTok: 0, outTokAborted: 0, cost: 0, capped: 0, stops: 0 };
  const waits = [];
  for (const r of list) {
    for (const k of ['requests', 'aborted', 'errors', 'segs', 'dupSegs', 'inTok', 'missTok', 'hitTok', 'outTok', 'outTokAborted', 'cost', 'capped', 'stops']) t[k] += r[k] || 0;
    waits.push(...(r.waits || []));
  }
  Object.assign(t, { ttfFirst: null, openFull: null, waitMean: mean(waits), waitP90: pct(waits, 0.9), waitMax: waits.length ? Math.max(...waits) : null });
  return t;
}

let finished = false;
async function cleanup() {
  await closeBrowser();
  await sim.close().catch(() => {});
  await pages.close().catch(() => {});
  for (const d of userDirs) rmSync(d, { recursive: true, force: true });
}
const watchdog = setTimeout(async () => {
  console.error(`\nwatchdog: bench exceeded ${WATCHDOG} ms, aborting`);
  await cleanup(); process.exit(3);
}, WATCHDOG);
watchdog.unref();
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, async () => { if (!finished) { await cleanup(); process.exit(130); } });

const t0 = Date.now();
let exitCode = 0;
log(`Duet-Translator bench: label=${LABEL}\n  ext=${EXT}\n  sim=${sim.url}  pages=${pages.base}`);
if (Object.keys(OVERRIDES).length) log(`  overrides=${JSON.stringify(OVERRIDES)}`);
if (Object.keys(SETTINGS).length) log(`  settings=${JSON.stringify(SETTINGS)}`);
try {
  for (const name of SCENARIOS) {
    if (!scenarios[name]) { log(`unknown scenario: ${name}`); continue; }
    const ts = Date.now();
    log(`\n[${name}] …`);
    try {
      results[name] = await scenarios[name]();
      const r = results[name];
      log(`  ${((Date.now() - ts) / 1000).toFixed(1)}s  req=${r.requests} abort=${r.aborted} segs=${r.segs} cost=${fmtCost(r.cost)} first=${fmtN(r.ttfFirst)}ms waits=[${r.waits.join(',')}]` +
        (r.status && r.status.err ? `  STATUS ERROR: ${r.status.text}` : '') + (r.errors ? `  HTTP errors=${r.errors}` : ''));
    } catch (e) {
      exitCode = 1;
      log(`  FAILED: ${(e && e.stack) || e}`);
      results[name] = { name, failed: String((e && e.message) || e) };
    }
  }
} finally {
  const ok = Object.values(results).filter((r) => !r.failed);
  const tot = total(ok);
  const out = {
    label: LABEL, date: new Date().toISOString(), extDir: EXT, git: gitInfo(EXT), elapsedSec: +((Date.now() - t0) / 1000).toFixed(1),
    overrides: OVERRIDES, settingsPatch: SETTINGS, effective, sim: sim.cfg,
    params: { readSteps: READ_STEPS, dwellMs: DWELL, capMs: CAP, viewport: '1400x900', targetLang: 'zh-CN' },
    scenarios: results, total: tot,
  };
  mkdirSync(OUT, { recursive: true });
  const file = join(OUT, `${LABEL}.json`);
  writeFileSync(file, JSON.stringify(out, null, 1));
  if (effective) {
    const p = effective.provider;
    log(`\nprovider: batchChars=${p.batchChars} batchSize=${p.batchSize} concurrency=${p.concurrency} model=${p.model} extraBody=${p.extraBody}  prefetchScreens=${effective.settings.prefetchScreens}`);
  }
  log(`\n### ${LABEL}  (${out.elapsedSec}s, ext ${out.git ? out.git.commit + (out.git.dirty ? '+dirty' : '') : '?'})\n`);
  log(table([...ok, tot]));
  log(`\ncost = miss×$${sim.cfg.priceMiss} + hit×$${sim.cfg.priceHit} + out×$${sim.cfg.priceOut} per 1M tokens; waits capped at ${CAP} ms\nwrote ${file}`);
  finished = true;
  await cleanup();
  clearTimeout(watchdog);
}
process.exit(exitCode);
