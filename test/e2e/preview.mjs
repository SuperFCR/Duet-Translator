// 段内预览（长段落边生成边显示）：慢慢吐字的假服务 → ①生成中能看到半截译文 ②最终结构完整（链接保留）
// ③生成到一半被取消的段落恢复为原文，不会留下半截译文
import { chromium } from 'playwright';
import http from 'node:http';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startServer, fakeTranslate } from './server.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const EXT = resolve(here, '../../extension');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
const check = (ok, msg, extra) => {
  console.log(`${ok ? '  ✔' : '  ✖'} ${msg}${extra !== undefined ? '  ' + JSON.stringify(extra) : ''}`);
  if (!ok) failures++;
};

/* 慢吐字服务：译文按 8 字符一块、每块 120ms 流式发出；记录每个请求是否被中途断开 */
const reqs = [];
const tr = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    const j = JSON.parse(body);
    const user = j.messages.find((m) => m.role === 'user').content;
    const arr = user.trim().startsWith('[') ? JSON.parse(user) : null;
    const out = arr ? JSON.stringify(arr.map(fakeTranslate)) : fakeTranslate(user);
    const rec = { segs: arr || [user], done: false, aborted: false };
    reqs.push(rec);
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.on('close', () => { if (!rec.done) rec.aborted = true; });
    let k = 0;
    const tick = () => {
      if (res.destroyed) return;
      if (k >= out.length) { rec.done = true; res.end('data: [DONE]\n\n'); return; }
      res.write('data: ' + JSON.stringify({ choices: [{ delta: { content: out.slice(k, k + 8) } }] }) + '\n\n');
      k += 8;
      setTimeout(tick, 120);
    };
    setTimeout(tick, 300);
  });
});
await new Promise((r) => tr.listen(0, '127.0.0.1', r));
const TR = `http://127.0.0.1:${tr.address().port}`;

const srv = await startServer(0);
const BASE = `http://127.0.0.1:${srv.port}`;
const ctx = await chromium.launchPersistentContext(mkdtempSync(join(tmpdir(), 'st-prev-')), {
  channel: 'chromium', headless: true, viewport: { width: 1400, height: 900 },
  args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`],
});
let [sw] = ctx.serviceWorkers();
if (!sw) sw = await ctx.waitForEvent('serviceworker');
await sleep(1200);
for (const p of ctx.pages()) if (p.url().includes('welcome')) await p.close();
await sw.evaluate(async (base) => {
  const s = await globalThis.PT.loadSettings();
  const providers = s.providers.filter((p) => p.id !== 'trickle').concat([{
    id: 'trickle', type: 'openai', name: 'trickle', baseUrl: base + '/v1', apiKey: 'k', model: 'm',
    temperature: '', extraBody: '', batchChars: 1500, batchSize: 20, concurrency: 3, timeoutMs: 30000,
  }]);
  await globalThis.PT.saveSettings({ providers, activeProviderId: 'trickle', targetLang: 'zh-CN', uiLang: 'zh', prefetchScreens: 0.5 });
}, TR);

const page = ctx.pages()[0] || await ctx.newPage();
await page.goto(`${BASE}/article.html`);
await sw.evaluate(async () => { const t = (await chrome.tabs.query({}))[0]; await globalThis.PT_toggleTab(t.id, {}); });
let L, R;
for (let i = 0; i < 100 && !(L && R); i++) {
  await sleep(100);
  L = page.frames().find((f) => f.name().startsWith('__pt:L:'));
  R = page.frames().find((f) => f.name().startsWith('__pt:R:'));
}

// 每个 data-idx 块：原文（左）/ 当前（右）/ 链接数
const snap = async () => {
  const get = (f) => f.evaluate(() => Object.fromEntries([...document.querySelectorAll('[data-idx]')]
    .map((e) => [e.dataset.idx, { t: e.textContent.replace(/\s+/g, ' ').trim(), a: e.querySelectorAll('a').length }])));
  return { l: await get(L), r: await get(R) };
};

console.log('\n[preview] 段内预览');
// ① 生成中：某段已经出现"译:"开头的半截译文（比最终短）
let sawPartial = null;
for (let i = 0; i < 40 && !sawPartial; i++) {
  await sleep(150);
  const { l, r } = await snap();
  for (const [k, v] of Object.entries(r)) {
    if (!v.t.startsWith('译:') || !l[k]) continue;
    const full = fakeTranslate(l[k].t).replace(/\s+/g, ' ').trim();
    if (v.t.length < full.length * 0.8) { sawPartial = { idx: k, shown: v.t.length, full: full.length }; break; }
  }
}
check(!!sawPartial, '长段落生成中就显示了半截译文（不用等整段生成完）', sawPartial);

// ② 等首屏全部完成：译文段落的链接数与原文一致（结构完整）
await sleep(9000);
{
  const { l, r } = await snap();
  const done = Object.entries(r).filter(([, v]) => v.t.startsWith('译:'));
  const badLinks = done.filter(([k, v]) => l[k] && v.a !== l[k].a).map(([k]) => k);
  check(done.length >= 5 && badLinks.length === 0, '最终译文覆盖预览，行内链接全部保留', { 已译: done.length, 链接不一致: badLinks });
}

// ③ 中途取消：新位置开始生成后立刻划远；被中断的请求里的段落必须恢复为原文
const n0 = reqs.length;
await page.mouse.move(350, 500);
for (let i = 0; i < 4; i++) { await page.mouse.wheel(0, 700); await sleep(60); }   // 到一个新位置
await sleep(1600);                                      // 停下 → 新请求开始吐字（预览已出现）
const before = await snap();
const partialBefore = Object.entries(before.r).filter(([k, v]) => v.t.startsWith('译:') && before.l[k] &&
  v.t.length < fakeTranslate(before.l[k].t).replace(/\s+/g, ' ').trim().length * 0.8).map(([k]) => k);
check(partialBefore.length > 0, '划走前，新位置已有段落显示半截预览（下面的恢复检查才有意义）', partialBefore);
for (let i = 0; i < 14; i++) { await page.mouse.wheel(0, 700); await sleep(60); }  // 划远 → 取消
await sleep(1500);
for (let i = 0; i < 18; i++) { await page.mouse.wheel(0, -700); await sleep(60); } // 回到中间附近看那些段落
await sleep(400);
{
  const aborted = reqs.slice(n0).filter((q) => q.aborted);
  const abortedSegs = new Set(aborted.flatMap((q) => q.segs.map((x) => x.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim())));
  const { l, r } = await snap();
  // 被中断请求里的段落：如果之后没有完成的请求重新翻译它，右侧必须与原文一致
  const redone = new Set(reqs.slice(n0).filter((q) => q.done).flatMap((q) => q.segs.map((x) => x.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim())));
  const restored = partialBefore.filter((k) => r[k] && l[k] && r[k].t === l[k].t);
  check(restored.length > 0 && partialBefore.every((k) => r[k] && (r[k].t === l[k].t || r[k].t.length >= fakeTranslate(l[k].t).replace(/\s+/g, ' ').trim().length * 0.8)),
    '划走前显示半截预览的段落：要么恢复原文，要么已完整译完', { 恢复: restored, 预览段: partialBefore });
  // 半截 = 显示的是译文但明显短于完整译文；整段已生成完的段落（取消前就流式到达）保留是正常的
  const fullLen = (t) => fakeTranslate(t).replace(/\s+/g, ' ').trim().length;
  const broken = Object.entries(l).filter(([k, v]) => abortedSegs.has(v.t) && !redone.has(v.t) && r[k] && r[k].t !== v.t && r[k].t.length < fullLen(v.t) * 0.8)
    .map(([k, v]) => ({ k, shown: r[k].t.length, full: fullLen(v.t) }));
  const keptWhole = Object.entries(l).filter(([k, v]) => abortedSegs.has(v.t) && r[k] && r[k].t !== v.t && r[k].t.length >= fullLen(v.t) * 0.8).map(([k]) => k);
  if (keptWhole.length) console.log('    （取消前已完整到达、保留的段落：' + keptWhole.join(', ') + '）');
  check(aborted.length > 0, '划走后，生成到一半的请求被取消', { 取消: aborted.length });
  check(broken.length === 0, '被取消的段落恢复为原文，没有留下半截译文', broken.slice(0, 3));
}

await ctx.close();
srv.close(); tr.close();
console.log(failures ? `\n${failures} 项失败` : '\n全部通过');
process.exit(failures ? 1 : 0);
