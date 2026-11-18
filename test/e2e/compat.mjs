// 真实网站兼容性巡检（Mock 引擎，不调用任何 API）：两侧加载、译文回填、滚动对齐、关闭恢复。
//   node e2e/compat.mjs            # 全部站点
//   node e2e/compat.mjs github mdn # 只跑名字包含这些关键字的站点
import { chromium } from 'playwright';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const SITES = [
  { name: 'wikipedia', url: 'https://en.wikipedia.org/wiki/Typography' },
  { name: 'wikipedia-zh→en', url: 'https://zh.wikipedia.org/wiki/%E6%B4%BB%E5%AD%97%E5%8D%B0%E5%88%B7%E6%9C%AF', target: 'en' },
  { name: 'github-readme', url: 'https://github.com/SuperFCR/Duet-Translator' },
  { name: 'github-docs', url: 'https://docs.github.com/en/get-started/start-your-journey/hello-world' },
  { name: 'mdn', url: 'https://developer.mozilla.org/en-US/docs/Web/API/Intersection_Observer_API' },
  { name: 'python-docs', url: 'https://docs.python.org/3/tutorial/introduction.html' },
  { name: 'react-docs', url: 'https://react.dev/learn' },
  { name: 'hacker-news', url: 'https://news.ycombinator.com/item?id=8863' },
  { name: 'arxiv-ar5iv', url: 'https://ar5iv.labs.arxiv.org/html/1706.03762' },
  { name: 'guardian', url: 'https://www.theguardian.com/uk' },
  { name: 'bbc', url: 'https://www.bbc.com/news' },
  { name: 'stackoverflow', url: 'https://stackoverflow.com/questions/11227809' },
  { name: 'medium', url: 'https://medium.com/@karpathy/software-2-0-a64152b37c35' },
  { name: 'old-reddit', url: 'https://old.reddit.com/r/programming/' },
];

const here = dirname(fileURLToPath(import.meta.url));
const EXT = resolve(here, '../../extension');
const OUT = join(here, 'out', 'compat');
mkdirSync(OUT, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const only = process.argv.slice(2);
const sites = only.length ? SITES.filter((s) => only.some((k) => s.name.includes(k))) : SITES;

const proxy = process.env.https_proxy || process.env.HTTPS_PROXY;
const dir = mkdtempSync(join(tmpdir(), 'st-compat-'));
const ctx = await chromium.launchPersistentContext(dir, {
  channel: 'chromium', headless: true, viewport: { width: 1400, height: 900 },
  userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36 Edg/140.0.0.0',
  args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`],
  ...(proxy ? { proxy: { server: proxy, bypass: '127.0.0.1,localhost' } } : {}),
});
let [sw] = ctx.serviceWorkers();
if (!sw) sw = await ctx.waitForEvent('serviceworker');
for (let i = 0; i < 20; i++) {
  const w = ctx.pages().find((p) => p.url().includes('/welcome/welcome.html'));
  if (w) { await w.close(); break; }
  await sleep(150);
}

// 在窗格主世界里量：主滚动容器、焦点线、焦点线下方的文本块（elementFromPoint 往上找最近的块级文本元素）。
// 另一侧按原文文本找同一块（Mock 译文里保留了原文），不依赖 DOM 路径——两次加载的页面结构可能不完全一样（横幅、广告）。
const probe = (needle) => {
  const se = document.scrollingElement || document.documentElement;
  let sc = null;
  if (se.scrollHeight - se.clientHeight <= 40) {
    let bs = 0;
    for (const el of document.body.querySelectorAll('*')) {
      if (el.scrollHeight - el.clientHeight < 40) continue;
      const oy = getComputedStyle(el).overflowY;
      if (oy !== 'auto' && oy !== 'scroll') continue;
      const s = el.clientWidth * el.clientHeight;
      if (s > bs) { bs = s; sc = el; }
    }
  }
  const t = sc ? sc.scrollTop : scrollY, vh = sc ? sc.clientHeight : se.clientHeight, H = sc ? sc.scrollHeight : se.scrollHeight;
  const max = H - vh, r = max > 0 ? t / max : 0;
  const vtop = sc ? sc.getBoundingClientRect().top + sc.clientTop : 0;
  const fy = vtop + r * vh;
  const base = { t: Math.round(t), max, fy, textLen: document.body ? document.body.innerText.length : 0 };
  const norm = (x) => x.replace(/\s+/g, ' ').trim();
  const isBlock = (e) => { const d = getComputedStyle(e).display; return d !== 'inline' && d !== 'contents'; };
  const inFixed = (e) => { for (let x = e; x && x !== document.body; x = x.parentElement) { const p = getComputedStyle(x).position; if (p === 'fixed' || p === 'sticky') return true; } return false; };
  const resolve = (needle) => {
    const head = needle.slice(0, 12);
    const hits = [];
    for (const e of document.body.querySelectorAll('*')) {
      const tc = e.textContent;
      if (!tc || tc.length < needle.length || !tc.includes(head) || !norm(tc).includes(needle)) continue;
      const b = e.getBoundingClientRect();
      if (b.height < 8 || !isBlock(e)) continue;
      hits.push({ e, b });
    }
    const deepest = hits.filter((h) => !hits.some((o) => o !== h && h.e.contains(o.e)));
    deepest.sort((a, b) => Math.abs((a.b.top + a.b.bottom) / 2 - fy) - Math.abs((b.b.top + b.b.bottom) / 2 - fy));
    const best = deepest[0];
    return { rect: best ? [best.b.top, best.b.bottom] : null, hits: deepest.length };
  };
  if (needle) return Object.assign(base, resolve(needle));
  const vw = se.clientWidth;
  for (const x of [0.4, 0.3, 0.55, 0.2, 0.7].map((k) => vw * k)) {
    let e = document.elementFromPoint(x, fy);
    while (e && e !== document.body && e !== document.documentElement) {
      const b = e.getBoundingClientRect();
      if (isBlock(e) && norm(e.textContent).length >= 24 && b.height < vh * 0.6) break;
      e = e.parentElement;
    }
    if (!e || e === document.body || e === document.documentElement || inFixed(e)) continue;
    const b = e.getBoundingClientRect();
    let longest = '';
    const w = document.createTreeWalker(e, NodeFilter.SHOW_TEXT);
    for (let n = w.nextNode(); n; n = w.nextNode()) { const x = norm(n.data); if (x.length > longest.length) longest = x; }
    if (longest.length < 20) continue;
    // 两侧用同一种方式定位"同一块"（包含指纹的最深块级元素），避免一侧量到容器、另一侧量到段落
    const nd = longest.slice(0, 48);
    const own = resolve(nd);
    if (!own.rect) continue;
    return Object.assign(base, own, { needle: nd, tag: e.localName });
  }
  return Object.assign(base, { rect: null, needle: null });
};

const statusText = (page) => page.evaluate(() => {
  const s = document.querySelector('pt-split-root')?.shadowRoot.getElementById('status');
  return s ? { text: s.textContent, tip: s.title } : null;
});

const results = [];
for (const [n, site] of sites.entries()) {
  const r = { name: site.name, url: site.url };
  const page = await ctx.newPage();
  const t0 = Date.now();
  let timer = 0;
  const siteTimeout = new Promise((_, rej) => { timer = setTimeout(() => rej(new Error('site timeout (120s)')), 120000); });
  try {
    await Promise.race([siteTimeout, (async () => {
    await sw.evaluate((tl) => globalThis.PT.saveSettings({ uiLang: 'zh', activeProviderId: 'mock', targetLang: tl, prefetchScreens: 0.5 }), site.target || 'zh-CN');
    const resp = await page.goto(site.url, { waitUntil: 'domcontentloaded', timeout: 45000 }).catch((e) => { r.navError = String(e.message).split('\n')[0]; return null; });
    r.http = resp ? resp.status() : null;
    await sleep(2500);
    r.plainTextLen = await page.evaluate(() => (document.body ? document.body.innerText.length : 0)).catch(() => 0);
    r.title = (await page.title().catch(() => '')).slice(0, 60);
    await sw.evaluate(async (u) => {
      const tabs = await chrome.tabs.query({});
      const t = tabs.find((x) => x.url === u) || tabs.find((x) => x.active);
      await globalThis.PT_toggleTab(t.id, {});
    }, page.url());
    let L = null, R = null;
    for (let i = 0; i < 75 && !(L && R); i++) {
      await sleep(200);
      L = page.frames().find((f) => f.name().startsWith('__pt:L:'));
      R = page.frames().find((f) => f.name().startsWith('__pt:R:'));
    }
    r.split = !!(L && R);
    if (!r.split) throw new Error('split view did not open');
    // 两侧加载完成（有正文）
    let a = null, b = null;
    for (let i = 0; i < 40; i++) {
      [a, b] = await Promise.all([L.evaluate(probe, null).catch(() => null), R.evaluate(probe, null).catch(() => null)]);
      if (a && b && a.textLen > 200 && b.textLen > 200) break;
      await sleep(500);
    }
    r.paneTextLen = [a ? a.textLen : 0, b ? b.textLen : 0];
    r.sameUrl = L.url() === R.url();
    // 等首屏译文
    let st = null;
    for (let i = 0; i < 30; i++) {
      st = await statusText(page);
      const m = st && /已翻译 (\d+)\/(\d+)/.exec(st.text);
      if (m && +m[1] > 0) break;
      await sleep(500);
    }
    const m = st && /已翻译 (\d+)\/(\d+)/.exec(st.text);
    r.translated = m ? [+m[1], +m[2]] : null;
    r.statusError = st && /失败|错误/.test(st.text) ? st.text : '';
    // 滚动对齐：滚左侧，量焦点线所在文本块在右侧的位置误差
    const measure = async () => {
      const pa = await L.evaluate(probe, null).catch((e) => { if (process.env.COMPAT_DEBUG) console.log('probe L failed', String(e).slice(0, 200)); return null; });
      if (process.env.COMPAT_DEBUG) console.log('L', pa && { t: pa.t, fy: Math.round(pa.fy), needle: pa.needle, tag: pa.tag, rect: pa.rect });
      if (!pa || !pa.needle) return null;
      const pb = await R.evaluate(probe, pa.needle).catch(() => null);
      if (!pb || !pb.rect) return null;
      const f = (pa.fy - pa.rect[0]) / Math.max(1, pa.rect[1] - pa.rect[0]);
      if (f < 0 || f > 1) return null;   // 焦点线落在段落之间的空隙：空隙按两侧段高比例伸缩，不作为对齐误差
      const err = Math.round(pb.rect[0] + f * (pb.rect[1] - pb.rect[0]) - pb.fy);
      if (process.env.COMPAT_DEBUG && Math.abs(err) > 3) {
        console.log('MIS', JSON.stringify({ err, needle: pa.needle, tag: pa.tag, L: { t: pa.t, fy: Math.round(pa.fy), rect: pa.rect.map(Math.round) }, R: { t: pb.t, fy: Math.round(pb.fy), rect: pb.rect.map(Math.round), hits: pb.hits } }));
        await page.screenshot({ path: join(OUT, `mis-${site.name}-${Math.abs(err)}.png`) });
      }
      return err;
    };
    const early = [], late = [];
    for (let k = 0; k < 7; k++) {
      await page.mouse.move(350, 520);
      await page.mouse.wheel(0, 650);
      await sleep(1600);
      early.push(await measure());
      await sleep(1900);
      late.push(await measure());
    }
    const mx = (xs) => { const ok = xs.filter((e) => e != null).map(Math.abs); return ok.length ? Math.max(...ok) : null; };
    r.alignEarly = early; r.alignLate = late;
    r.alignMax = mx(late); r.alignMaxEarly = mx(early);
    const after = await Promise.all([L.evaluate(probe, null).catch(() => null), R.evaluate(probe, null).catch(() => null)]);
    r.scrolled = after.map((x) => (x ? x.t : null));
    st = await statusText(page);
    const am = st && /对齐锚点 (\d+)/.exec(st.tip || '');
    r.anchors = am ? +am[1] : null;
    const m2 = st && /已翻译 (\d+)\/(\d+)/.exec(st.text);
    r.translatedAfterScroll = m2 ? [+m2[1], +m2[2]] : null;
    await page.screenshot({ path: join(OUT, `${String(n + 1).padStart(2, '0')}-${site.name}.png`) });
    // 关闭：分屏移除，原页面恢复
    await page.locator('pt-split-root #close').click();
    await sleep(800);
    r.closed = await page.evaluate(() => !document.querySelector('pt-split-root') && !document.documentElement.classList.contains('__pt-on')).catch(() => false);
    })()]);
  } catch (e) {
    r.error = String(e.message || e).split('\n')[0];
    await page.screenshot({ path: join(OUT, `${String(n + 1).padStart(2, '0')}-${site.name}.png`) }).catch(() => {});
  }
  clearTimeout(timer);
  r.seconds = Math.round((Date.now() - t0) / 1000);
  results.push(r);
  console.log(JSON.stringify(r));
  await page.close().catch(() => {});
}

writeFileSync(join(OUT, 'compat.json'), JSON.stringify(results, null, 2));
console.log('\nsite                 http split  panes(L/R chars)   translated   anchors align@1.6s align@3.5s closed  note');
for (const r of results) {
  console.log([
    r.name.padEnd(20), String(r.http ?? '-').padEnd(4), String(r.split ?? '-').padEnd(5),
    String(r.paneTextLen ? r.paneTextLen.join('/') : '-').padEnd(18),
    String(r.translatedAfterScroll ? r.translatedAfterScroll.join('/') : '-').padEnd(12),
    String(r.anchors ?? '-').padEnd(7), String(r.alignMaxEarly ?? '-').padEnd(10), String(r.alignMax ?? '-').padEnd(10), String(r.closed ?? '-').padEnd(7),
    r.error || r.navError || r.statusError || '',
  ].join(' '));
}
await ctx.close();
rmSync(dir, { recursive: true, force: true });
