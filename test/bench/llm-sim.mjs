// llm-sim.mjs — OpenAI 兼容的"模拟 LLM"：DeepSeek-Flash 风格的计费（含前缀缓存）与延迟模型。
//
//   POST {any}/chat/completions      流式 SSE（stream:true）与非流式均支持
//   GET  /v1/models                  （连通性测试用）
//   GET  /__log                      每个请求一条记录
//   GET  /__stats                    汇总（含美元成本）
//   POST /__reset[?cache=1]          清空日志（cache=1 同时清空前缀缓存）
//   GET|POST /__config               查看 / 修改运行时参数（JSON body 合并进配置）
//
// 单独运行：PORT=8790 node bench/llm-sim.mjs     （参数见 DEFAULTS / ENV_MAP）
// 也可按请求覆盖延迟参数：查询串 ?ttft=800&tps=30，或路径前缀 /cfg/ttft=800,tps=30/v1/chat/completions
// （后者可直接写进扩展的 baseUrl）。
import http from 'node:http';
import { fileURLToPath } from 'node:url';

export const DEFAULTS = {
  ttftMs: 600,            // 首 token 固定延迟
  ttftPerTokMs: 0.05,     // 每个未命中缓存的输入 token 追加的预填充延迟
  tps: 45,                // 输出速度 token/s
  chunkTokens: 2,         // 每个 SSE 块大约多少 token
  ratio: 0.55,            // 译文字符数 / 原文字符数（英→中）
  latinTok: 0.3,          // 拉丁/其他字符 ≈ 0.3 token
  cjkTok: 0.6,            // 中日韩字符 ≈ 0.6 token
  cacheBlock: 64,         // 前缀缓存按 64 token 取整
  priceMiss: 0.14,        // USD / 1M 输入 token（缓存未命中）
  priceHit: 0.0028,       // USD / 1M 输入 token（缓存命中）
  priceOut: 0.28,         // USD / 1M 输出 token
  defaultMaxTokens: 8192, // 请求未给 max_tokens 时的上限
  rejectStreamOptions: false,   // true：带 stream_options 的请求返回 400（测试客户端降级）
  logText: false,         // true：日志里附上每段原文前 80 字（调试用）
};
const ENV_MAP = {
  SIM_TTFT_MS: 'ttftMs', SIM_TTFT_PER_TOKEN_MS: 'ttftPerTokMs', SIM_TPS: 'tps', SIM_CHUNK_TOKENS: 'chunkTokens',
  SIM_RATIO: 'ratio', SIM_LATIN_TOK: 'latinTok', SIM_CJK_TOK: 'cjkTok', SIM_CACHE_BLOCK: 'cacheBlock',
  SIM_PRICE_MISS: 'priceMiss', SIM_PRICE_HIT: 'priceHit', SIM_PRICE_OUT: 'priceOut',
  SIM_DEFAULT_MAX_TOKENS: 'defaultMaxTokens', SIM_REJECT_STREAM_OPTIONS: 'rejectStreamOptions', SIM_LOG_TEXT: 'logText',
};
const QUERY_MAP = { ttft: 'ttftMs', ttftPerTok: 'ttftPerTokMs', tps: 'tps', chunk: 'chunkTokens', ratio: 'ratio' };

export function cfgFromEnv(env = process.env) {
  const c = {};
  for (const [k, key] of Object.entries(ENV_MAP)) {
    if (env[k] == null || env[k] === '') continue;
    c[key] = key === 'rejectStreamOptions' || key === 'logText' ? /^(1|true|yes)$/i.test(env[k]) : +env[k];
  }
  return c;
}

/* ------------------------------ token 估算 ------------------------------ */
const CJK_RE = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}　-〿＀-￯]/u;
const isCjk = (ch) => CJK_RE.test(ch);
export function tokWeight(ch, cfg = DEFAULTS) { return isCjk(ch) ? cfg.cjkTok : cfg.latinTok; }
/** 估算 token 数（未取整） */
export function estTokens(s, cfg = DEFAULTS) {
  let n = 0;
  for (const ch of String(s || '')) n += tokWeight(ch, cfg);
  return n;
}

/* ------------------------------ 假翻译 ------------------------------ */
const HAN = '的一是在不了有和人这中大为上个国我以要他时来用们生到作地于出就分对成会可主发年动同工也能下过子说产种面而方后多定' +
  '行学法所民得经十三之进着等部度家电力里如水化高自二理起小物现实加量都两体制机当使点从业本去把性好应开它合还因由其些然前外天' +
  '政四日那社义事平形相全表间样与关各重新线内数正心反你明看原又么利比或但质气第向道命此变条只没结解问意建月公无系军很情者最立' +
  '代想已通并提直题程展五果料象员革位入常文总次品式活设及管特件长求老头基资边流路级少图山统接知较将组见计别她手角期根论运农指';
function fnv(s) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return h >>> 0;
}
export const segHash = (s) => fnv(String(s)).toString(16).padStart(8, '0');

/** 一段纯文字 → 长度约 ratio 倍的伪中文（确定性：同一原文同一译文） */
function fakeZh(piece, cfg) {
  if (!/\p{L}/u.test(piece)) return piece;                       // 纯空白/标点/数字：原样
  const letters = piece.match(/\p{L}/gu) || [];
  if (letters.filter(isCjk).length / letters.length > 0.5) return piece;   // 已是中文：原样返回
  const n = Math.max(1, Math.round(piece.trim().length * cfg.ratio));
  let seed = fnv(piece);
  const rnd = () => {   // mulberry32
    seed = (seed + 0x6d2b79f5) >>> 0;
    let t = seed;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  let out = '', sinceComma = 0;
  for (let i = 0; i < n; i++) {
    if (i === n - 1 && n > 3 && /[.!?]\s*$/.test(piece)) { out += '。'; break; }
    if (sinceComma > 6 && i < n - 2 && rnd() < 0.12) { out += '，'; sinceComma = 0; continue; }
    out += HAN[Math.floor(rnd() * HAN.length)];
    sinceComma++;
  }
  return out;
}
/** 保留 <gN>…</gN> / <xN/> 等标签，只"翻译"标签之间的文字 */
export function fakeTranslate(s, cfg = DEFAULTS) {
  return String(s).split(/(<\/?[A-Za-z][\w-]*\s*\/?>)/).map((p, i) => (i % 2 ? p : fakeZh(p, cfg))).join('');
}

/** 从 user 消息里找 JSON 数组（允许前面有说明/上下文文字）；也接受 {id: text} 对象 */
function findBatch(text) {
  const t = String(text || '');
  const tryShape = (open, close, ok) => {
    const j = t.lastIndexOf(close);
    for (let i = t.indexOf(open); i >= 0 && i < j; i = t.indexOf(open, i + 1)) {
      let v;
      try { v = JSON.parse(t.slice(i, j + 1)); } catch (_) { continue; }
      if (ok(v)) return v;
    }
    return null;
  };
  const isItem = (x) => typeof x === 'string' || (x && typeof x === 'object' && (typeof x.text === 'string' || typeof x.t === 'string'));
  const arr = tryShape('[', ']', (v) => Array.isArray(v) && v.length > 0 && v.every(isItem));
  if (arr) return { kind: 'array', value: arr };
  const obj = tryShape('{', '}', (v) => v && typeof v === 'object' && !Array.isArray(v) && Object.keys(v).length > 0 &&
    Object.values(v).every((x) => typeof x === 'string'));
  if (obj) return { kind: 'object', value: obj };
  return null;
}
function translateItem(x, cfg) {
  if (typeof x === 'string') return fakeTranslate(x, cfg);
  const o = Object.assign({}, x);
  if (typeof o.text === 'string') o.text = fakeTranslate(o.text, cfg);
  if (typeof o.t === 'string') o.t = fakeTranslate(o.t, cfg);
  return o;
}
const itemText = (x) => (typeof x === 'string' ? x : x.text || x.t || '');

const contentOf = (m) => (typeof m.content === 'string' ? m.content
  : Array.isArray(m.content) ? m.content.map((p) => (p && typeof p.text === 'string' ? p.text : '')).join('') : '');

/* ------------------------------ 服务器 ------------------------------ */
export function startSim(opts = {}) {
  const cfg = Object.assign({}, DEFAULTS, cfgFromEnv(), opts.cfg || {});
  let log = [];
  let cache = [];          // 已完成预填充的请求（序列化后的 messages）
  let seq = 0;
  const active = new Set();
  const startedAt = Date.now();

  const lcp = (a, b) => { const n = Math.min(a.length, b.length); let i = 0; while (i < n && a.charCodeAt(i) === b.charCodeAt(i)) i++; return i; };
  const costOf = (e, c) => (e.missTok * c.priceMiss + e.cachedTok * c.priceHit + e.outTok * c.priceOut) / 1e6;

  function stats(entries = log) {
    const s = { requests: entries.length, aborted: 0, errors: 0, nSegs: 0, inTok: 0, cachedTok: 0, missTok: 0, outTok: 0, outTokAborted: 0, cost: 0, active: active.size };
    for (const e of entries) {
      if (e.aborted) { s.aborted++; s.outTokAborted += e.outTok; }
      if (e.status !== 200) s.errors++;
      s.nSegs += e.nSegs; s.inTok += e.inTok; s.cachedTok += e.cachedTok; s.missTok += e.missTok; s.outTok += e.outTok; s.cost += e.cost;
    }
    return s;
  }

  function json(res, code, obj) {
    res.writeHead(code, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify(obj));
  }

  function handleChat(req, res, body, rcfg) {
    const t0 = Date.now();
    let j;
    try { j = JSON.parse(body); } catch (_) { return json(res, 400, { error: { message: 'invalid JSON body', type: 'invalid_request_error' } }); }
    const msgs = Array.isArray(j.messages) ? j.messages : [];
    const e = {
      id: ++seq, t0, ttfb: null, tEnd: null, aborted: false, status: 200, stream: !!j.stream, model: j.model || '',
      mode: 'single', nSegs: 0, inChars: 0, inTok: 0, cachedTok: 0, missTok: 0, outTok: 0, outTokPlanned: 0,
      maxTokens: j.max_tokens ?? j.max_completion_tokens ?? null, finish: null, cost: 0, segs: [],
      streamOptions: j.stream_options || null,
    };
    log.push(e);
    if (rcfg.rejectStreamOptions && j.stream_options) {
      e.status = 400; e.tEnd = Date.now(); e.finish = 'error';
      return json(res, 400, { error: { message: 'Invalid request: unrecognized parameter `stream_options` (simulated rejection)', type: 'invalid_request_error', param: 'stream_options' } });
    }
    if (!msgs.length) { e.status = 400; e.tEnd = Date.now(); return json(res, 400, { error: { message: 'messages is required', type: 'invalid_request_error' } }); }

    // ---- 输入 token / 前缀缓存 ----
    const ser = msgs.map((m) => `${m.role}\n${contentOf(m)}\n`).join('');
    const allContent = msgs.map(contentOf).join('');
    e.inChars = allContent.length;
    e.inTok = Math.ceil(estTokens(allContent, rcfg));
    let best = 0;
    for (const p of cache) { const l = lcp(p, ser); if (l > best) best = l; }
    const prefTok = estTokens(ser.slice(0, best), rcfg);
    e.cachedTok = Math.min(e.inTok, Math.floor(prefTok / rcfg.cacheBlock) * rcfg.cacheBlock);
    e.missTok = e.inTok - e.cachedTok;

    // ---- 生成"译文" ----
    const lastUser = [...msgs].reverse().find((m) => m.role === 'user');
    const userText = lastUser ? contentOf(lastUser) : '';
    const batch = findBatch(userText);
    let content;
    if (batch && batch.kind === 'array') {
      e.mode = 'batch'; e.nSegs = batch.value.length; e.segs = batch.value.map((x) => segHash(itemText(x)));
      content = JSON.stringify(batch.value.map((x) => translateItem(x, rcfg)));
    } else if (batch && batch.kind === 'object') {
      e.mode = 'batch-obj'; const vals = Object.values(batch.value); e.nSegs = vals.length; e.segs = vals.map((x) => segHash(x));
      content = JSON.stringify(Object.fromEntries(Object.entries(batch.value).map(([k, v]) => [k, fakeTranslate(v, rcfg)])));
    } else {
      e.nSegs = 1; e.segs = [segHash(userText.trim())];
      content = fakeTranslate(userText.trim(), rcfg);
    }

    if (rcfg.logText) {
      e.texts = batch ? (batch.kind === 'array' ? batch.value.map(itemText) : Object.values(batch.value)) : [userText.trim()];
      e.texts = e.texts.map((x) => String(x).slice(0, 80));
    }

    // ---- max_tokens 截断，切成流式块 ----
    const maxTok = Math.max(1, +(e.maxTokens ?? rcfg.defaultMaxTokens) || rcfg.defaultMaxTokens);
    const chunks = [];   // { text, tok, cum }  cum = 该块之前累计 token
    let cur = '', curTok = 0, cum = 0, truncated = false;
    for (const ch of content) {
      const w = tokWeight(ch, rcfg);
      if (cum + curTok + w > maxTok + 1e-9) { truncated = true; break; }
      cur += ch; curTok += w;
      if (curTok >= rcfg.chunkTokens) { chunks.push({ text: cur, tok: curTok, cum }); cum += curTok; cur = ''; curTok = 0; }
    }
    if (cur) { chunks.push({ text: cur, tok: curTok, cum }); cum += curTok; }
    const finish = truncated ? 'length' : 'stop';
    const totalOut = cum;
    e.outTokPlanned = Math.ceil(totalOut);
    const ttft = rcfg.ttftMs + rcfg.ttftPerTokMs * e.missTok;
    const msPerTok = 1000 / rcfg.tps;

    const timers = new Set();
    const at = (ms, fn) => { const t = setTimeout(() => { timers.delete(t); fn(); }, Math.max(0, t0 + ms - Date.now())); timers.add(t); };
    let emittedTok = 0, done = false;
    const usage = () => ({
      prompt_tokens: e.inTok, completion_tokens: e.outTok, total_tokens: e.inTok + e.outTok,
      prompt_cache_hit_tokens: e.cachedTok, prompt_cache_miss_tokens: e.missTok,
      prompt_tokens_details: { cached_tokens: e.cachedTok },
    });
    const finishEntry = (aborted) => {
      if (done) return;
      done = true;
      active.delete(e);
      for (const t of timers) clearTimeout(t);
      e.tEnd = Date.now();
      e.aborted = aborted;
      if (aborted) {
        e.outTok = e.stream ? Math.ceil(emittedTok)
          : Math.ceil(Math.min(totalOut, Math.max(0, (e.tEnd - t0 - ttft) / msPerTok)));
        e.finish = 'aborted';
      } else { e.outTok = Math.ceil(totalOut); e.finish = finish; }
      e.cost = costOf(e, rcfg);
      if (!aborted || e.tEnd - t0 >= ttft) cache.push(ser);   // 预填充完成即进入缓存
    };
    active.add(e);
    res.on('close', () => { if (!res.writableFinished) finishEntry(true); });
    const id = 'chatcmpl-sim-' + e.id, created = Math.floor(t0 / 1000), model = e.model || 'sim';

    if (j.stream) {
      res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache', Connection: 'keep-alive', 'Access-Control-Allow-Origin': '*' });
      res.flushHeaders();
      const send = (obj) => res.write('data: ' + JSON.stringify(obj) + '\n\n');
      chunks.forEach((c, k) => at(ttft + c.cum * msPerTok, () => {
        if (done || res.destroyed) return;
        if (e.ttfb == null) e.ttfb = Date.now() - t0;
        send({ id, object: 'chat.completion.chunk', created, model, choices: [{ index: 0, delta: k === 0 ? { role: 'assistant', content: c.text } : { content: c.text }, finish_reason: null }] });
        emittedTok += c.tok;
      }));
      at(ttft + totalOut * msPerTok, () => {
        if (done || res.destroyed) return;
        if (e.ttfb == null) e.ttfb = Date.now() - t0;
        e.outTok = Math.ceil(totalOut);
        send({ id, object: 'chat.completion.chunk', created, model, choices: [{ index: 0, delta: {}, finish_reason: finish }], usage: usage() });
        finishEntry(false);
        res.end('data: [DONE]\n\n');
      });
    } else {
      at(ttft + totalOut * msPerTok, () => {
        if (done || res.destroyed) return;
        e.ttfb = Date.now() - t0;
        e.outTok = Math.ceil(totalOut);
        finishEntry(false);
        json(res, 200, { id, object: 'chat.completion', created, model,
          choices: [{ index: 0, message: { role: 'assistant', content: chunks.map((c) => c.text).join('') }, finish_reason: finish }], usage: usage() });
      });
    }
  }

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    let path = url.pathname;
    const rcfg = Object.assign({}, cfg);
    const m = /^\/cfg\/([^/]+)(\/.*)$/.exec(path);
    if (m) {
      for (const kv of decodeURIComponent(m[1]).split(',')) { const [k, v] = kv.split('='); if (QUERY_MAP[k] && v !== '' && !Number.isNaN(+v)) rcfg[QUERY_MAP[k]] = +v; }
      path = m[2];
    }
    for (const [k, key] of Object.entries(QUERY_MAP)) { const v = url.searchParams.get(k); if (v != null && v !== '' && !Number.isNaN(+v)) rcfg[key] = +v; }

    if (req.method === 'OPTIONS') {
      res.writeHead(204, { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*', 'Access-Control-Allow-Methods': 'GET,POST,OPTIONS' });
      return res.end();
    }
    const readBody = (fn) => { let b = ''; req.setEncoding('utf8'); req.on('data', (c) => { b += c; }); req.on('end', () => fn(b)); };
    if (req.method === 'POST' && path.endsWith('/chat/completions')) return readBody((b) => handleChat(req, res, b, rcfg));
    if (req.method === 'GET' && path.endsWith('/models')) return json(res, 200, { object: 'list', data: [{ id: 'deepseek-flash', object: 'model', owned_by: 'sim' }] });
    if (path === '/__log') return json(res, 200, log);
    if (path === '/__stats') return json(res, 200, stats());
    if (path === '/__reset' && req.method === 'POST') {
      log = []; if (url.searchParams.get('cache') === '1') cache = [];
      return json(res, 200, { ok: true });
    }
    if (path === '/__config') {
      if (req.method === 'POST') return readBody((b) => { try { Object.assign(cfg, JSON.parse(b || '{}')); json(res, 200, cfg); } catch (err) { json(res, 400, { error: String(err) }); } });
      return json(res, 200, cfg);
    }
    json(res, 404, { error: { message: 'not found: ' + path } });
  });
  server.keepAliveTimeout = 30000;

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(opts.port ?? 0, opts.host || '127.0.0.1', () => {
      const port = server.address().port;
      resolve({
        port, url: `http://127.0.0.1:${port}/v1`, cfg, startedAt,
        get log() { return log; },
        stats, costOf,
        activeCount: () => active.size,
        reset: ({ cache: c = false } = {}) => { log = []; if (c) cache = []; },
        close: () => new Promise((r) => { server.closeAllConnections?.(); server.close(() => r()); }),
      });
    });
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const sim = await startSim({ port: +process.env.PORT || 8790 });
  console.log(`llm-sim: ${sim.url}  (POST /chat/completions; GET /__log /__stats; POST /__reset[?cache=1]; GET|POST /__config)`);
  console.log(JSON.stringify(sim.cfg));
}
