// Records the promo clips into promo/assets/:
//   01-open.mp4  02-sync-scroll.mp4  03-hover.mp4  04-cache.mp4  (+ poster PNGs)  05-meter.png  hero.png
// Run from anywhere:  node promo/footage/record.mjs   (needs translations.json; see capture.mjs)
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { startServer } from './server.mjs';
import {
  ASSETS, launch, configure, toggle, panes, waitIdle, waitTranslated, statusText, meterText, shadow,
  installCursor, glide, smoothScroll, startRecorder, encode, paneRect, sleep, mouse,
} from './lib.mjs';

const ONLY = (process.env.ONLY || '').split(',').filter(Boolean);   // e.g. ONLY=p1 or ONLY=p3
const want = (k) => !ONLY.length || ONLY.includes(k);
mkdirSync(ASSETS, { recursive: true });
const log = (...a) => console.log('[rec]', ...a);
const report = {};

const srv = await startServer({ speed: 1 });
const BASE = `http://127.0.0.1:${srv.port}`;
const URL = `${BASE}/article.html`;
const { ctx, sw } = await launch();
await configure(sw, BASE);

const configureHighlight = (sw, v) => sw.evaluate((v) => globalThis.PT.saveSettings({ highlight: v }), v);
const nth = (css, i) => `return document.querySelectorAll(${JSON.stringify(css)})[${i}]`;
const center = (r, fx = 0.5, fy = 0.5) => [Math.round(r.x + r.width * fx), Math.round(r.y + r.height * fy)];
const shotPoster = (page, name) => page.screenshot({ path: join(ASSETS, name) });
const assertClean = async (page, where) => {
  const s = await statusText(page);
  if (/fail|error|HTTP|timeout/i.test(s || '')) throw new Error(`status shows an error at ${where}: ${s}`);
  return s;
};

/** Scroll the left pane (by wheel, unrecorded) so that element `css[i]` sits at pane-y `y`. */
async function bringTo(page, L, css, i, y) {
  await glide(page, 880, 640, 120);
  for (let k = 0; k < 3; k++) {
    const r = await paneRect(page, 'L', L, nth(css, i));
    const fb = await page.locator('pt-split-root #L').boundingBox();
    const dy = Math.round(r.y - fb.y - y);
    if (Math.abs(dy) < 3) break;
    await page.mouse.wheel(0, dy);
    await sleep(900);
  }
}

/* =================== Page 1: 01-open · 04-cache · 05-meter =================== */
if (want('p1')) {
  const page = await ctx.newPage();
  page.on('dialog', (d) => d.accept());
  await page.goto(URL);
  await page.waitForLoadState('load');
  await sleep(800);
  await installCursor(page, 1500, 820);
  const rec = await startRecorder(page, 'p1');
  await sleep(300);
  rec.mark('c01-start');
  await sleep(900);
  await glide(page, 1858, 64, 950);          // toward the toolbar corner, where the extension icon lives
  await sleep(250);
  await toggle(sw, URL);
  rec.mark('toggle');
  await panes(page);
  await waitIdle(page, { timeout: 30000, stableMs: 500 });
  rec.mark('stream-done');
  await sleep(1400);
  rec.mark('c01-end');
  report['01-open'] = { status: await assertClean(page, '01'), meter: await meterText(page) };
  await shotPoster(page, '01-open.png');

  // ---- 04: close, reopen -> instant from cache, rest on the meter ----
  await sleep(500);
  rec.mark('c04-start');
  const close = await page.locator('pt-split-root #close').boundingBox();
  await glide(page, 1858, 19, 350);
  await glide(page, ...center(close), 350);
  await sleep(200);
  await page.mouse.click(...center(close));
  rec.mark('close');
  await page.waitForFunction(() => !document.querySelector('pt-split-root'), null, { timeout: 5000 }).catch(() => {});
  await sleep(1300);
  await toggle(sw, URL);
  rec.mark('reopen');
  const tReopen = Date.now();
  await panes(page);
  for (let i = 0; i < 100; i++) { if (/^\s*[1-9]/.test(((await statusText(page)) || '').split('·')[1] || '')) break; await sleep(50); }
  const filledMs = Date.now() - tReopen;
  rec.mark('reopen-filled');
  await sleep(1000);
  const meter = await page.locator('pt-split-root #meter').boundingBox();
  await glide(page, ...center(meter, 0.8, 0.92), 800);   // pointer tip on the badge's lower edge, text stays readable
  await sleep(2200);
  rec.mark('c04-end');
  report['04-cache'] = { status: await assertClean(page, '04'), meter: await meterText(page), reopenToFilledMs: filledMs, meterBox: meter, closeBox: close };
  await shotPoster(page, '04-cache.png');
  const { frames, marks } = await rec.stop();
  const M = Object.fromEntries(marks.map((m) => [m.label, m.t]));
  report.p1marks = M;
  report['01-open'].duration = encode(frames, join(ASSETS, '01-open.mp4'), { from: M['c01-start'], to: M['c01-end'] });
  report['04-cache'].duration = encode(frames, join(ASSETS, '04-cache.mp4'), { from: M['c04-start'], to: M['c04-end'] });
  report['01-open'].toggleAt = +(M.toggle - M['c01-start']).toFixed(2);
  report['01-open'].streamDoneAt = +(M['stream-done'] - M['c01-start']).toFixed(2);
  report['04-cache'].closeAt = +(M.close - M['c04-start']).toFixed(2);
  report['04-cache'].reopenAt = +(M.reopen - M['c04-start']).toFixed(2);
  rmSync(join(tmpdir(), 'duet-promo-frames', 'p1'), { recursive: true, force: true });

  // ---- 05: scroll into untranslated territory so the meter shows tokens · from cache · $ ----
  await glide(page, 880, 640, 200);
  await smoothScroll(page, 1100, 700);
  await sleep(400);
  await smoothScroll(page, 1100, 700);
  await waitIdle(page, { timeout: 30000 });
  await sleep(500);
  const mt = await meterText(page);
  report['05-meter'] = { meter: mt, status: await assertClean(page, '05') };
  await glide(page, 600, 19, 200);    // park the pointer on the bar (no pane hover); cursor hidden for the still
  await page.evaluate(() => { const c = document.getElementById('__promo_cursor'); if (c) c.style.display = 'none'; });
  const bar = await shadow(page, `const b = sr.querySelector('.bar').getBoundingClientRect(); const m = sr.getElementById('meter').getBoundingClientRect();
    return { h: b.height, mr: m.right }`);
  const cdp = await ctx.newCDPSession(page);
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1920, height: 1080, deviceScaleFactor: 2, mobile: false });
  await sleep(800);
  // CDP capture honours the 2x device scale (page.screenshot would render at the context's 1x)
  const cap = async (file, width) => {
    const r = await cdp.send('Page.captureScreenshot', { format: 'png', clip: { x: 0, y: 0, width, height: Math.ceil(bar.h), scale: 1 } });
    writeFileSync(join(ASSETS, file), Buffer.from(r.data, 'base64'));
  };
  await cap('05-meter.png', Math.ceil(bar.mr + 14));
  await cap('05-meter-bar.png', 1920);
  await cdp.send('Emulation.clearDeviceMetricsOverride');
  await page.close();
}

/* =================== Pre-warm: translate the whole article once (cache) =================== */
if (want('p3')) {
  const page = await ctx.newPage();
  page.on('dialog', (d) => d.accept());
  await page.goto(URL);
  await sleep(500);
  await toggle(sw, URL);
  await panes(page);
  await sleep(1200);
  await page.locator('pt-split-root #all').click();
  log('prewarm', await waitTranslated(page, 90000));
  await page.close();
}

/* =================== Page 3: 02-sync-scroll · 03-hover · hero =================== */
if (want('p3')) {
  const page = await ctx.newPage();
  page.on('dialog', (d) => d.accept());
  await page.goto(URL);
  await sleep(600);
  await installCursor(page, 880, 640);
  await toggle(sw, URL);
  const { L, R } = await panes(page);
  await waitIdle(page);
  await sleep(800);
  await glide(page, 880, 640, 100);

  // ---- 02: slow reading scroll on the left, then drive from the right ----
  // hover highlight off for this clip (it has its own clip); keeps the focus on the alignment
  await configureHighlight(sw, 'off');
  await sleep(500);
  let rec = await startRecorder(page, 'p3a');
  await sleep(300);
  rec.mark('c02-start');
  await sleep(600);
  await smoothScroll(page, 500, 1500);
  await sleep(550);
  await smoothScroll(page, 560, 1500);
  await sleep(550);
  await smoothScroll(page, 600, 1600);
  await sleep(650);
  rec.mark('to-right');
  await glide(page, 1838, 600, 850);
  await sleep(200);
  await smoothScroll(page, 700, 1800);
  await sleep(900);
  rec.mark('c02-end');
  report['02-sync-scroll'] = { status: await assertClean(page, '02'), meter: await meterText(page) };
  await shotPoster(page, '02-sync-scroll.png');
  let { frames, marks } = await rec.stop();
  let M = Object.fromEntries(marks.map((m) => [m.label, m.t]));
  report['02-sync-scroll'].duration = encode(frames, join(ASSETS, '02-sync-scroll.mp4'), { from: M['c02-start'], to: M['c02-end'] });
  report['02-sync-scroll'].rightSideAt = +(M['to-right'] - M['c02-start']).toFixed(2);
  rmSync(join(tmpdir(), 'duet-promo-frames', 'p3a'), { recursive: true, force: true });

  // ---- 03: hover paragraphs, both sides highlight ----
  await configureHighlight(sw, 'hover');
  await sleep(500);
  await bringTo(page, L, 'article h2', 1, 70);   // "A living limestone factory"
  await glide(page, 880, 700, 150);
  await sleep(600);
  rec = await startRecorder(page, 'p3b');
  await sleep(300);
  rec.mark('c03-start');
  await sleep(500);
  const P = (side, frame, css, i) => paneRect(page, side, frame, nth(css, i));
  await glide(page, ...center(await P('L', L, 'article p', 10), 0.42, 0.4), 800);
  await sleep(1150);
  await glide(page, ...center(await P('L', L, 'article p', 11), 0.55, 0.5), 650);
  await sleep(1150);
  await glide(page, ...center(await P('R', R, 'article p', 12), 0.45, 0.45), 950);
  await sleep(1200);
  await glide(page, ...center(await P('R', R, 'ul.needs li', 1), 0.35, 0.5), 600);
  await sleep(1300);
  rec.mark('c03-end');
  report['03-hover'] = { status: await assertClean(page, '03') };
  await shotPoster(page, '03-hover.png');
  ({ frames, marks } = await rec.stop());
  M = Object.fromEntries(marks.map((m) => [m.label, m.t]));
  report['03-hover'].duration = encode(frames, join(ASSETS, '03-hover.mp4'), { from: M['c03-start'], to: M['c03-end'] });
  rmSync(join(tmpdir(), 'duet-promo-frames', 'p3b'), { recursive: true, force: true });

  // ---- hero: mid-article, one paragraph highlighted ----
  await glide(page, 880, 640, 150);
  await bringTo(page, L, 'article h2', 0, 64);    // "Darwin's sinking mountains"
  await glide(page, 880, 640, 100);
  await sleep(500);
  await glide(page, ...center(await P('L', L, 'article p', 6), 0.9, 0.72), 500);   // blank end of a line, text unobscured
  await sleep(900);
  report.hero = { status: await assertClean(page, 'hero') };
  await page.screenshot({ path: join(ASSETS, 'hero.png') });
  await page.close();
}

await ctx.close();
srv.close();
writeFileSync(join(ASSETS, '..', 'footage', 'last-run.json'), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
if (srv.misses.length) console.log('missing translations:', srv.misses.length);
