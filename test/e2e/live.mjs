// 真实引擎冒烟测试：用真实的 OpenAI 兼容 API 跑一遍完整流程（演示页 + 可选真实网页）。
// Key 只从环境变量读取，写入临时浏览器配置，测试结束即删除。
//   LIVE_BASE_URL=https://api.deepseek.com LIVE_MODEL=deepseek-flash LIVE_API_KEY=sk-... \
//   LIVE_EXTRA='{"reasoning_effort":"low"}' [LIVE_URL=https://en.wikipedia.org/wiki/Typography] node e2e/live.mjs
import { chromium } from 'playwright';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startServer } from './server.mjs';

const env = process.env;
if (!env.LIVE_API_KEY || !env.LIVE_BASE_URL || !env.LIVE_MODEL) {
  console.error('需要 LIVE_BASE_URL / LIVE_MODEL / LIVE_API_KEY');
  process.exit(2);
}
const here = dirname(fileURLToPath(import.meta.url));
const EXT = resolve(here, '../../extension');
const OUT = join(here, 'out');
mkdirSync(OUT, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const srv = await startServer(0);
const BASE = `http://127.0.0.1:${srv.port}`;
const userDir = mkdtempSync(join(tmpdir(), 'st-live-'));
const proxyUrl = env.https_proxy || env.HTTPS_PROXY;
const ctx = await chromium.launchPersistentContext(userDir, {
  channel: 'chromium', headless: true, viewport: { width: 1400, height: 900 },
  args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`],
  ...(proxyUrl ? { proxy: { server: proxyUrl, bypass: '127.0.0.1,localhost' } } : {}),
});
let [sw] = ctx.serviceWorkers();
if (!sw) sw = await ctx.waitForEvent('serviceworker');

try {
  await sw.evaluate(async (cfg) => {
    const s = await globalThis.PT.loadSettings();
    const providers = s.providers.filter((p) => p.id !== 'live').concat([Object.assign({
      id: 'live', type: 'openai', name: 'live', temperature: 0.2, batchChars: 2400, batchSize: 24, concurrency: 3, timeoutMs: 120000,
    }, cfg)]);
    await globalThis.PT.saveSettings({ providers, activeProviderId: 'live', targetLang: 'zh-CN', highlight: 'hover' });
  }, { name: env.LIVE_NAME || 'live', baseUrl: env.LIVE_BASE_URL, apiKey: env.LIVE_API_KEY, model: env.LIVE_MODEL, extraBody: env.LIVE_EXTRA || '' });

  // 先在 SW 里直连一次，确认引擎可用
  const t0 = Date.now();
  const direct = await sw.evaluate(async (segs) => {
    const s = await globalThis.PT.loadSettings();
    const cfg = s.providers.find((p) => p.id === 'live');
    try { return { r: await globalThis.PT.providers.openai.translate(segs, cfg, { from: 'auto', to: 'zh-CN', page: {} }) }; }
    catch (e) { return { e: String((e && e.message) || e) }; }
  }, ['Hello, <g1>world</g1>! Press <x2/> to continue.', 'Both panes scroll together, paragraph by paragraph.']);
  console.log(`[direct] ${Date.now() - t0}ms`, JSON.stringify(direct));

  const pages = (env.LIVE_SKIP_DEMO ? [] : [`${BASE}/article.html`]).concat(env.LIVE_URL ? [env.LIVE_URL] : []);
  for (const [i, url] of pages.entries()) {
    console.log(`\n[page] ${url}`);
    const page = await ctx.newPage();
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await sw.evaluate(async (u) => {
      const tabs = await chrome.tabs.query({});
      const t = tabs.find((x) => x.url === u) || tabs.find((x) => x.active);
      await globalThis.PT_toggleTab(t.id, {});
    }, page.url());
    let R = null, L = null;
    for (let k = 0; k < 100 && !R; k++) {
      await sleep(100);
      R = page.frames().find((f) => f.name().startsWith('__pt:R:'));
      L = page.frames().find((f) => f.name().startsWith('__pt:L:'));
    }
    const tStart = Date.now();
    const got = await R.waitForFunction(() => /[一-鿿]{4,}/.test(document.body.innerText), null, { timeout: 90000 }).then(() => true, () => false);
    console.log(`  首屏出现中文译文: ${got} (${Date.now() - tStart}ms)`);
    // 往下滚几屏，让懒翻译跑起来，并量对齐
    const errs = [];
    const visDone = () => R.evaluate(() => {
      const ps = [...document.querySelectorAll('p')].filter((p) => { const r = p.getBoundingClientRect(); return r.bottom > 0 && r.top < innerHeight && p.textContent.trim().length > 40; });
      return ps.every((p) => /[\u4e00-\u9fff]{3,}/.test(p.textContent));
    });
    for (let k = 0; k < 4; k++) {
      await page.mouse.move(350, 500);
      await page.mouse.wheel(0, 900);
      const ts = Date.now();
      let ok = false;
      while (!ok && Date.now() - ts < 20000) { await sleep(250); ok = await visDone(); }
      console.log(`  第 ${k + 1} 次停下 → 当前屏翻完: ${ok ? ((Date.now() - ts) / 1000).toFixed(1) + 's' : '>20s'}`);
      const [a, b] = await Promise.all([L, R].map((f) => f.evaluate(() => {
        const se = document.scrollingElement; const max = se.scrollHeight - se.clientHeight;
        // 视口内正文段落中已出现中文的比例
        const ps = [...document.querySelectorAll('p')].filter((p) => { const r = p.getBoundingClientRect(); return r.bottom > 0 && r.top < innerHeight && p.textContent.trim().length > 40; });
        const zh = ps.filter((p) => /[\u4e00-\u9fff]{3,}/.test(p.textContent)).length;
        return { t: se.scrollTop, max, vis: `${zh}/${ps.length}` };
      })));
      errs.push({ L: Math.round(a.t), R: Math.round(b.t), R视口段落已译: b.vis });
    }
    console.log('  滚动位置(L/R):', JSON.stringify(errs));
    const where = await R.evaluate(() => {
      const out = { above: 0, inView: 0, below: 0 };
      for (const e of document.querySelectorAll('p, li, h1, h2, h3, td, a, span, div')) {
        if (!/[\u4e00-\u9fff]{2,}/.test(e.textContent) || e.querySelector('p, li, h1, h2, h3, td, a, span, div')) continue;
        const r = e.getBoundingClientRect();
        if (r.bottom < 0) out.above++; else if (r.top > innerHeight) out.below++; else out.inView++;
      }
      return out;
    });
    console.log('  已译元素相对视口分布:', JSON.stringify(where));
    const status = await page.evaluate(() => document.querySelector('pt-split-root').shadowRoot.getElementById('status').textContent);
    console.log('  状态栏:', status);
    const samples = await R.evaluate(() => [...document.querySelectorAll('p, li, h1, h2, h3')]
      .filter((e) => /[一-鿿]/.test(e.textContent)).slice(0, 6)
      .map((e) => ({ tag: e.localName, text: e.textContent.trim().slice(0, 110), links: e.querySelectorAll('a').length, code: e.querySelectorAll('code').length })));
    for (const s of samples) console.log('  ·', JSON.stringify(s));
    await page.mouse.move(330, 420);
    await sleep(400);
    await page.screenshot({ path: join(OUT, `live-${i}.png`) });
    for (const l of ['zh', 'en']) {   // 两种界面语言各截一张（README 用）
      await sw.evaluate((x) => globalThis.PT.saveSettings({ uiLang: x }), l);
      await sleep(600);
      await page.screenshot({ path: join(OUT, `live-${i}-${l}.png`) });
    }
    await page.close();
  }
} finally {
  await ctx.close();
  srv.close();
  rmSync(userDir, { recursive: true, force: true });   // 删除含 key 的临时浏览器配置
}
