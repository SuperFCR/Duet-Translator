// 缓存 / 去重 / 用量 / 参数回退 测试：直接在 Service Worker 里调用，配合一个可控的假 OpenAI 服务
import { chromium } from 'playwright';
import http from 'node:http';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const EXT = resolve(here, '../../extension');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
const check = (ok, msg, extra) => {
  console.log(`${ok ? '  ✔' : '  ✖'} ${msg}${extra !== undefined ? '  ' + JSON.stringify(extra) : ''}`);
  if (!ok) failures++;
};

/* 假服务：记录每次请求的段落；/nostreamopt 拒绝 stream_options；/badtags 弄乱标签 */
const log = [];
const srv = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    const j = JSON.parse(body || '{}');
    const path = new URL(req.url, 'http://x').pathname;
    log.push({ path, body: j });
    if (path.startsWith('/nostreamopt') && j.stream_options) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      return res.end('{"error":{"message":"Unrecognized request argument supplied: stream_options"}}');
    }
    const user = j.messages.find((m) => m.role === 'user').content;
    const arr = user.trim().startsWith('[') ? JSON.parse(user) : null;
    const tr = (s) => (path.startsWith('/badtags') ? '译:' + s.replace(/<\/?g\d+>/g, '') : '译:' + s);
    const content = arr ? JSON.stringify(arr.map(tr)) : tr(user);
    const usage = { prompt_tokens: 100, completion_tokens: 40, prompt_cache_hit_tokens: 64, prompt_cache_miss_tokens: 36 };
    setTimeout(() => {
      if (j.stream) {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        res.write('data: ' + JSON.stringify({ choices: [{ delta: { content } }] }) + '\n\n');
        res.write('data: ' + JSON.stringify({ choices: [], usage }) + '\n\n');
        return res.end('data: [DONE]\n\n');
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { content } }], usage }));
    }, 400);
  });
});
await new Promise((r) => srv.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${srv.address().port}`;

const ctx = await chromium.launchPersistentContext(mkdtempSync(join(tmpdir(), 'st-cache-')), {
  channel: 'chromium', headless: true,
  args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`],
});
let [sw] = ctx.serviceWorkers();
if (!sw) sw = await ctx.waitForEvent('serviceworker');
await sleep(800);

const cfg = (path, extra) => Object.assign({ id: 'fake', type: 'openai', baseUrl: base + path + '/v1', apiKey: 'k', model: 'm', batchChars: 2000, batchSize: 20, concurrency: 4 }, extra || {});
// 通过 SW 的消息处理逻辑翻译（与窗格走同一路径）
const tr = (msg) => sw.evaluate(async (m) => {
  const settings = await globalThis.PT.loadSettings();
  return globalThis.__ptTranslateForTest(m, settings);
}, msg);
await sw.evaluate(() => {
  // 测试钩子：复用 onMessage 的 translate 处理器
  globalThis.__ptTranslateForTest = (m) => new Promise((resolve) => {
    globalThis.PT_handlers.translate(m, {}).then(resolve, (e) => resolve({ error: String(e.message || e) }));
  });
});

console.log('\n[cache] 去重 / 在途共享');
log.length = 0;
const segs = ['Reply', 'Share', 'Reply', 'A longer paragraph about typography.', 'Reply'];
const r1 = await tr({ type: 'translate', cfg: cfg(''), to: 'zh-CN', segments: segs, page: { url: 'https://a.example/p1' } });
const sent1 = log.flatMap((l) => { const u = l.body.messages[1].content; return u.startsWith('[') ? JSON.parse(u) : [u]; });
check(r1.results && r1.results.length === 5 && r1.results[4] === '译:Reply', '重复段落都拿到译文', r1.results);
check(sent1.filter((x) => x === 'Reply').length === 1, '同一请求内重复原文只发送一次', sent1);
check(r1.dedup === 2, '返回去重计数', r1.dedup);

log.length = 0;
const [ra, rb] = await Promise.all([
  tr({ type: 'translate', cfg: cfg(''), to: 'zh-CN', segments: ['Concurrent one', 'Concurrent two'], page: { url: 'https://a.example/p2' } }),
  sleep(50).then(() => tr({ type: 'translate', cfg: cfg(''), to: 'zh-CN', segments: ['Concurrent two', 'Concurrent three'], page: { url: 'https://a.example/p2' } })),
]);
const sent2 = log.flatMap((l) => { const u = l.body.messages[1].content; return u.startsWith('[') ? JSON.parse(u) : [u]; });
check(ra.results[1] === '译:Concurrent two' && rb.results[0] === '译:Concurrent two', '并发请求共享在途译文');
check(sent2.filter((x) => x === 'Concurrent two').length === 1, '在途的同一原文不会重复发送', sent2);

console.log('\n[cache] 命中 / 仅查缓存 / 用量');
log.length = 0;
const r3 = await tr({ type: 'translate', cfg: cfg(''), to: 'zh-CN', segments: ['Reply', 'Never seen'], cacheOnly: true, page: { url: 'https://a.example/p1' } });
check(r3.results[0] === '译:Reply' && r3.results[1] == null && log.length === 0, 'cacheOnly：只返回命中，不发请求', r3);
check(r1.usage && r1.usage.inTok === 100 && r1.usage.cachedTok === 64 && r1.usage.outTok === 40, '流式最后一块的 usage 被记录（含服务端缓存命中）', r1.usage);
// 流式路径：直接调 provider（窗格请求都是流式的）
const streamTr = (path, segsIn) => sw.evaluate(async ([c, sg]) => {
  const us = [];
  const out = await globalThis.PT.providers.openai.translate(sg, c, { from: 'auto', to: 'zh-CN', page: {}, onItem() {}, onUsage: (u) => us.push(u) });
  return { out, us };
}, [cfg(path), segsIn]);
log.length = 0;
const s0 = await streamTr('', ['Fresh text here', 'Another one']);
const body0 = log[0].body;
check(body0.stream === true && body0.stream_options && body0.stream_options.include_usage === true && body0.max_tokens >= 1024, '流式请求带 stream_options 与 max_tokens', { so: body0.stream_options, mt: body0.max_tokens });
check(s0.us.length === 1 && s0.us[0].cachedTok === 64, '流式：最后一块的 usage 只记一次', s0.us);

console.log('\n[cache] 参数回退 / 坏标签不入缓存');
log.length = 0;
const r4 = await streamTr('/nostreamopt', ['Fallback works?', 'Second']);
check(r4.out && r4.out[0] === '译:Fallback works?', '不支持 stream_options 的服务：自动去掉后重试成功', r4.out);
check(log.length === 2 && !log[1].body.stream_options, '只多花一次失败请求', log.map((l) => !!l.body.stream_options));
log.length = 0;
await streamTr('/nostreamopt', ['Remembered?', 'Yes']);
check(log.length === 1 && !log[0].body.stream_options, '之后对该服务不再发送 stream_options', log.length);
log.length = 0;
await tr({ type: 'translate', cfg: cfg('/badtags', { id: 'bad' }), to: 'zh-CN', segments: ['See <g1>this</g1> link'], page: {} });
await tr({ type: 'translate', cfg: cfg('/badtags', { id: 'bad' }), to: 'zh-CN', segments: ['See <g1>this</g1> link'], page: {} });
check(log.length === 2, '标签被弄乱的译文不写缓存（下次重新翻译）', log.length);

console.log('\n[cache] 上下文窗口预算 / 回退记忆跨 SW 重启');
const unsupSaved = await sw.evaluate(async () => (await chrome.storage.session.get('unsupParams')).unsupParams || {});
check(Object.entries(unsupSaved).some(([k, v]) => k.includes('/nostreamopt') && v.includes('stream_options')), '不支持的参数记在 storage.session（SW 被回收后不用再失败一次）', unsupSaved);
log.length = 0;
const longSegs = Array.from({ length: 6 }, (_, i) => `Paragraph ${i}: ` + 'The quick brown fox jumps over the lazy dog. '.repeat(6));
const ctxRes = await sw.evaluate(async ([c, sg]) => {
  const out = await globalThis.PT.providers.openai.translate(sg, c, { from: 'auto', to: 'zh-CN', page: {}, onItem() {} });
  return out;
}, [cfg('', { id: 'small', contextTokens: 900 }), longSegs]);
const ctxReqs = log.map((l) => {
  const u = l.body.messages[1].content, sys = l.body.messages[0].content;
  const est = await0(sys, u);
  return { n: u.startsWith('[') ? JSON.parse(u).length : 1, mt: l.body.max_tokens, inEst: est };
});
function await0(sys, u) { const t = (x) => Math.ceil((x.match(/[\u3000-\u9fff]/g) || []).length * 0.6 + x.length * 0.3); return t(sys) + t(u) + 16; }
check(ctxRes.length === 6 && ctxRes[5].startsWith('译:Paragraph 5'), '超出上下文预算的批次被拆开，结果完整有序', ctxRes.map((x) => x.slice(0, 14)));
check(ctxReqs.length > 1 && ctxReqs.every((r) => r.inEst + r.mt <= 900), '每个请求：输入估算 + max_tokens ≤ 上下文窗口', ctxReqs);

console.log('\n[cache] 命中率统计');
const st = await sw.evaluate(async () => {
  const C = globalThis.PT.cache;
  const before = await C.info('');
  await C.getMany(['no-such-key-1', 'no-such-key-2', 'no-such-key-3']);
  const after = await C.info('');
  return { dMiss: after.misses - before.misses, hits: after.hits };
});
check(st.dMiss === 3, '未命中被计入（命中率不会恒为 100%）', st);

console.log('\n[cache] 清理：按页面 / 按引擎 / 淘汰');
const clear = (scope) => sw.evaluate((s) => globalThis.PT.cache.clear(s), scope);
const before = await sw.evaluate(() => globalThis.PT.cache.count());
const rp = await clear({ page: 'https://a.example/p2' });
check(rp.removed === 3, '按页面清除只删该页写入的条目', rp);
const rn = await clear({ nsPrefix: 'openai|bad|' });
check(rn.removed === 0, '按引擎清除（坏标签引擎没有条目）', rn);
const after = await sw.evaluate(() => globalThis.PT.cache.count());
check(after === before - 3, '计数一致', { before, after });

// 淘汰：上限 100 条；先写 150 条，其中 10 条被反复命中 → 第二次机会
const ev = await sw.evaluate(async () => {
  const C = globalThis.PT.cache;
  await C.clear();
  C.configure({ maxEntries: 100, maxMB: 64, ttlDays: 90 });
  const ks = Array.from({ length: 150 }, (_, i) => 'k' + String(i).padStart(4, '0'));
  // 逐条写入，访问时间递增
  for (let i = 0; i < ks.length; i += 10) { await C.putMany(ks.slice(i, i + 10), ks.slice(i, i + 10).map((k) => 'v' + k), { host: 'h', ns: 'n' }); await new Promise((r) => setTimeout(r, 3)); }
  // 最早写入的 10 条标记为高复用（命中 4 次）
  const db = await new Promise((res) => { const r = indexedDB.open('duet'); r.onsuccess = () => res(r.result); });
  await new Promise((res) => {
    const tx = db.transaction('tr', 'readwrite'); const st = tx.objectStore('tr');
    // 访问时间按序号排开（第 i 条 = (150-i) 分钟前），前 10 条命中 4 次
    const now = Date.now();
    ks.forEach((k, i) => { const g = st.get(k); g.onsuccess = () => { const v = g.result; v.t = now - (150 - i) * 60000; if (i < 10) v.h = 4; st.put(v); }; });
    tx.oncomplete = res;
  });
  C._l1.clear();
  const pr = await C.prune({ factor: 0.9 });
  const hot = await C.getMany(ks.slice(0, 10));
  const coldOld = await C.getMany(ks.slice(10, 20));
  const newest = await C.getMany(ks.slice(140, 150));
  // TTL：把 5 条的访问时间改到 200 天前
  await new Promise((res) => {
    const tx = db.transaction('tr', 'readwrite'); const st = tx.objectStore('tr');
    for (const k of ks.slice(140, 145)) { const g = st.get(k); g.onsuccess = () => { const v = g.result; v.t = Date.now() - 200 * 86400e3; st.put(v); }; }
    tx.oncomplete = res;
  });
  const pr2 = await C.prune();
  C.configure({});
  return { pr, pr2, hot: hot.filter(Boolean).length, coldOld: coldOld.filter(Boolean).length, newest: newest.filter(Boolean).length, n: await C.count() };
});
check(ev.pr.count <= 90 && ev.pr.evicted >= 50, '超出条数上限：淘汰到 90%', ev.pr);
check(ev.hot === 10, '高复用条目（命中≥2）获得第二次机会，被保留', ev);
check(ev.coldOld === 0 && ev.newest === 10, '最久没访问的普通条目先淘汰，最新的保留', ev);
check(ev.pr2.expired === 5, 'TTL：长期没读过的条目过期删除', ev.pr2);

await ctx.close();
srv.close();
console.log(failures ? `\n${failures} 项失败` : '\n全部通过');
process.exit(failures ? 1 : 0);
