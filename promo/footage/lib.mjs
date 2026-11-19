// Shared helpers for driving Duet-Translator in Playwright for promo footage.
import { createRequire } from 'node:module';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

export const here = dirname(fileURLToPath(import.meta.url));
export const REPO = resolve(here, '../..');
export const EXT = join(REPO, 'extension');
export const ASSETS = join(REPO, 'promo/assets');
const require = createRequire(join(REPO, 'test/package.json'));
export const { chromium } = require('playwright');

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const W = 1920, H = 1080;

const LIBS = `${process.env.HOME}/.cache/st-e2e-libs/root/usr/lib/x86_64-linux-gnu`;
export const browserEnv = {
  ...process.env,
  LD_LIBRARY_PATH: `${LIBS}:${LIBS}/nss` + (process.env.LD_LIBRARY_PATH ? ':' + process.env.LD_LIBRARY_PATH : ''),
  FONTCONFIG_FILE: join(here, 'fonts.conf'),
};

export async function launch({ userDir } = {}) {
  const dir = userDir || mkdtempSync(join(tmpdir(), 'duet-promo-'));
  const ctx = await chromium.launchPersistentContext(dir, {
    channel: 'chromium',
    headless: true,
    viewport: { width: W, height: H },
    screen: { width: W, height: H },
    deviceScaleFactor: 1,
    locale: 'en-US',
    env: browserEnv,
    args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`, '--hide-scrollbars', '--font-render-hinting=none'],
  });
  let [sw] = ctx.serviceWorkers();
  if (!sw) sw = await ctx.waitForEvent('serviceworker');
  // first install opens the welcome page: close it
  for (let i = 0; i < 30; i++) {
    const w = ctx.pages().find((p) => p.url().includes('/welcome/welcome.html'));
    if (w) { await w.close(); break; }
    await sleep(150);
  }
  for (const p of ctx.pages()) if (p.url().startsWith('chrome-extension://')) await p.close().catch(() => {});
  return { ctx, sw, userDir: dir };
}

export async function configure(sw, base) {
  await sw.evaluate(async (base) => {
    const cur = await globalThis.PT.loadSettings();
    const providers = cur.providers.map((p) => (p.id === 'deepseek'
      ? Object.assign({}, p, { name: 'DeepSeek V4 Flash', baseUrl: base + '/v1', apiKey: 'sk-demo', model: 'deepseek-flash' })
      : p));
    await globalThis.PT.saveSettings({
      uiLang: 'en', targetLang: 'zh-CN', sourceLang: 'auto', activeProviderId: 'deepseek',
      highlight: 'hover', syncScroll: true, devMode: false, providers,
    });
  }, base);
}

/** Toggle Duet on the tab showing `url` (the most recently opened one if several). */
export async function toggle(sw, url) {
  await sw.evaluate(async (url) => {
    const tabs = await chrome.tabs.query({});
    const t = tabs.filter((x) => (x.url || '').startsWith(url)).sort((a, b) => b.id - a.id)[0] || tabs.find((x) => x.active) || tabs[0];
    await globalThis.PT_toggleTab(t.id, {});
  }, url);
}

export async function panes(page) {
  for (let i = 0; i < 150; i++) {
    const fs = page.frames();
    const L = fs.find((f) => f.name().startsWith('__pt:L:'));
    const R = fs.find((f) => f.name().startsWith('__pt:R:'));
    if (L && R) return { L, R };
    await sleep(100);
  }
  throw new Error('panes not found');
}

export const shadow = (page, fn, arg) => page.evaluate(([src, a]) => {
  const sr = document.querySelector('pt-split-root')?.shadowRoot;
  // eslint-disable-next-line no-new-func
  return sr ? new Function('sr', 'a', src)(sr, a) : null;
}, [fn, arg]);

export const statusText = (page) => shadow(page, "return sr.getElementById('status').textContent");
export const meterText = (page) => shadow(page, "const m = sr.getElementById('meter'); return m.hidden ? '' : m.textContent");

/** Wait until the right pane reports done == total and nothing is in flight. */
export async function waitTranslated(page, timeout = 60000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    const s = await statusText(page) || '';
    const m = s.match(/(\d+)\/(\d+) paragraphs/);
    if (m && +m[1] === +m[2] && +m[2] > 0 && !/in flight/.test(s)) return s;
    await sleep(200);
  }
  throw new Error('timeout waiting for translation: ' + (await statusText(page)));
}

/* --------------------------- visible mouse cursor --------------------------- */
// Headless screencasts have no pointer; draw one in the top document, above the split overlay.
const CURSOR_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="28" height="34" viewBox="0 0 28 34"><defs><filter id="s" x="-40%" y="-40%" width="180%" height="180%"><feDropShadow dx="0" dy="1.5" stdDeviation="1.6" flood-opacity=".35"/></filter></defs><path filter="url(#s)" d="M3 2.5 L3 26.5 L9.2 20.6 L13.4 30.2 L17.6 28.4 L13.5 19 L22 19 Z" fill="#111" stroke="#fff" stroke-width="2" stroke-linejoin="round"/></svg>`;

export async function installCursor(page, x = W / 2, y = H / 2) {
  await page.evaluate(([svg, x, y]) => {
    let c = document.getElementById('__promo_cursor');
    if (!c) {
      c = document.createElement('div');
      c.id = '__promo_cursor';
      c.innerHTML = svg;
      c.style.cssText = 'all:initial;position:fixed;left:0;top:0;width:28px;height:34px;z-index:2147483647;pointer-events:none;will-change:transform;';
      // keep the cursor as the last child so it stays above the split overlay when that gets (re)attached
      new MutationObserver(() => { if (document.documentElement.lastElementChild !== c) document.documentElement.appendChild(c); })
        .observe(document.documentElement, { childList: true });
    }
    document.documentElement.appendChild(c);
    c.style.transform = `translate(${x - 3}px, ${y - 2}px)`;
    window.__promoCursor = (x, y) => { c.style.transform = `translate(${x - 3}px, ${y - 2}px)`; };
  }, [CURSOR_SVG, x, y]);
  mouse.x = x; mouse.y = y;
  await page.mouse.move(x, y);
}
export const mouse = { x: W / 2, y: H / 2 };
const setCursor = (page, x, y) => page.evaluate(([x, y]) => window.__promoCursor && window.__promoCursor(x, y), [x, y]).catch(() => {});

const easeInOut = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);

/** Human-ish mouse glide with easing and a slight arc (time-based: steps adapt to input latency). */
export async function glide(page, x, y, ms = 700) {
  const x0 = mouse.x, y0 = mouse.y;
  const bow = Math.min(60, Math.hypot(x - x0, y - y0) * 0.08);
  const t0 = Date.now();
  for (;;) {
    const f = Math.min(1, (Date.now() - t0) / ms);
    const t = easeInOut(f);
    const px = x0 + (x - x0) * t + Math.sin(Math.PI * t) * bow * 0.35;
    const py = y0 + (y - y0) * t - Math.sin(Math.PI * t) * bow;
    await page.mouse.move(px, py);
    await setCursor(page, px, py);
    if (f >= 1) break;
    await sleep(10);
  }
  mouse.x = x; mouse.y = y;
}

/**
 * Smooth wheel scroll of `dy` px over `ms` with ease-in-out velocity: one small wheel event per ~16 ms.
 * Events go straight to CDP without waiting for each ack (page.mouse.wheel round-trips take ~40 ms with
 * two panes listening, which would cap the scroll at ~25 updates/s and judder in a 30 fps video).
 */
const cdpSessions = new WeakMap();
async function cdpFor(page) {
  if (!cdpSessions.has(page)) cdpSessions.set(page, await page.context().newCDPSession(page));
  return cdpSessions.get(page);
}
export async function smoothScroll(page, dy, ms = 1600) {
  const cdp = await cdpFor(page);
  const pending = [];
  let done = 0;
  const t0 = Date.now();
  for (let k = 1; ; k++) {
    const f = Math.min(1, (Date.now() - t0) / ms);
    const step = Math.round(dy * easeInOut(f) - done);
    if (step) {
      pending.push(cdp.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: mouse.x, y: mouse.y, deltaX: 0, deltaY: step, modifiers: 0, pointerType: 'mouse' }));
      done += step;
    }
    if (f >= 1) break;
    const wait = t0 + k * 16.7 - Date.now();
    await sleep(Math.max(1, wait));
  }
  await Promise.all(pending);
}

/* ------------------------------ frame recorder ------------------------------ */
// page.screencast JPEG frames (q=95) -> x264 CRF 18. Keeps text crisper than the default VP9 recordVideo pipeline.
export async function startRecorder(page, name, { quality = 95, fps = 60 } = {}) {
  const dir = join(tmpdir(), 'duet-promo-frames', name);   // temporary, deleted after encoding
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const frames = [];
  const marks = [];
  let n = 0;
  const t0 = Date.now();
  const disp = await page.screencast.start({
    size: { width: W, height: H }, quality, fps,   // default would be 25 fps -> judder at 30 fps
    onFrame: ({ data, timestamp }) => {
      const f = join(dir, String(n++).padStart(6, '0') + '.jpg');
      writeFileSync(f, data);
      // compositor timestamp (epoch ms) -> same clock as marks
      frames.push({ f, t: (timestamp > 1e12 ? timestamp : Date.now()) - t0 });
    },
  });
  return {
    dir, frames,
    now: () => (Date.now() - t0) / 1000,
    mark: (label) => { marks.push({ label, t: (Date.now() - t0) / 1000 }); },
    marks,
    async stop() { await page.screencast.stop(); if (disp && disp[Symbol.asyncDispose]) await disp[Symbol.asyncDispose]().catch(() => {}); return { frames, marks }; },
  };
}

/** Encode recorded frames to a CFR 30 fps H.264 MP4 between [from, to] seconds. */
export function encode(frames, out, { from = 0, to = Infinity, fps = 30 } = {}) {
  if (!frames.length) throw new Error('no frames');
  if (process.env.DEBUG_FRAMES) {
    const sel = frames.filter((f) => f.t >= from * 1000 && f.t <= to * 1000);
    const h = {};
    sel.slice(1).forEach((f, i) => { const b = Math.round((f.t - sel[i].t) / 4) * 4; h[b] = (h[b] || 0) + 1; });
    console.log('[frames]', out, sel.length, 'frames; gap histogram (ms):', JSON.stringify(h));
  }
  // Constant-rate resampling in JS: for each output tick take the latest captured frame at or before it, and
  // lay the picks out as a numbered symlink sequence read at exactly `fps` (the concat demuxer would snap
  // per-image durations to 1/25 s and judder).
  const end = Math.min(to, frames[frames.length - 1].t / 1000 + 0.5);
  const ticks = Math.round((end - from) * fps);
  const seq = mkdtempSync(join(tmpdir(), 'duet-promo-seq-'));
  let k = 0;
  for (let i = 0; i < ticks; i++) {
    const t = (from + i / fps) * 1000;
    while (k + 1 < frames.length && frames[k + 1].t <= t) k++;
    symlinkSync(frames[k].f, join(seq, String(i).padStart(6, '0') + '.jpg'));
  }
  const r = spawnSync('/usr/bin/ffmpeg', ['-y', '-loglevel', 'error', '-framerate', String(fps), '-i', join(seq, '%06d.jpg'),
    '-c:v', 'libx264', '-preset', 'slow', '-crf', '18', '-pix_fmt', 'yuv420p', '-r', String(fps),
    '-movflags', '+faststart', out], { stdio: 'inherit' });
  rmSync(seq, { recursive: true, force: true });
  if (r.status !== 0) throw new Error('ffmpeg failed for ' + out);
  return ticks / fps;
}

/** Wait until the right pane has nothing in flight and the translated count is stable. */
export async function waitIdle(page, { timeout = 30000, stableMs = 700 } = {}) {
  const t0 = Date.now();
  let last = '', since = Date.now();
  while (Date.now() - t0 < timeout) {
    const s = (await statusText(page)) || '';
    const busy = await shadow(page, "return !sr.getElementById('busy').hidden");
    const ok = /paragraphs translated/.test(s) && !/in flight/.test(s) && !busy;
    if (s !== last || !ok) { last = s; since = Date.now(); }
    else if (Date.now() - since >= stableMs) return s;
    await sleep(100);
  }
  throw new Error('waitIdle timeout: ' + last);
}

/** Bounding box (page coords) of an element inside a pane, located by a function body run in the frame. */
export async function paneRect(page, side, frame, selectorFn) {
  const fb = await page.locator(`pt-split-root #${side}`).boundingBox();
  const r = await frame.evaluate((src) => {
    // eslint-disable-next-line no-new-func
    const el = new Function(src)();
    if (!el) return null;
    const b = el.getBoundingClientRect();
    return { x: b.left, y: b.top, width: b.width, height: b.height };
  }, selectorFn);
  return r && { x: fb.x + r.x, y: fb.y + r.y, width: r.width, height: r.height };
}
