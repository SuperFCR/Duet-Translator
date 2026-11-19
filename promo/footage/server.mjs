// Promo replay server: serves the demo article and a fake OpenAI-compatible endpoint that "streams"
// hand-written Simplified Chinese translations (translations.json, keyed by the exact source segment).
//   GET  /article.html             demo page (promo/footage/page/)
//   POST /v1/chat/completions      DeepSeek-style chat completions (SSE when stream: true, usage on the last chunk)
// Env: CAPTURE=1 -> record every received segment into segments.json; SPEED=<factor> scales pacing.
import http from 'node:http';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join, extname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const PAGE_DIR = join(here, 'page');
const TR_FILE = join(here, 'translations.json');
const SEG_FILE = join(here, 'segments.json');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rand = (a, b) => a + Math.random() * (b - a);
const norm = (s) => String(s).replace(/<\/?[gx]\d+\/?>/g, '').replace(/\s+/g, ' ').trim().toLowerCase();

function loadTranslations() {
  if (!existsSync(TR_FILE)) return { exact: new Map(), loose: new Map() };
  const obj = JSON.parse(readFileSync(TR_FILE, 'utf8'));
  const exact = new Map(Object.entries(obj));
  const loose = new Map(Object.entries(obj).map(([k, v]) => [norm(k), v]));
  return { exact, loose };
}

// Rough token estimate, same rule of thumb as the extension (Latin ~0.3 tok/char, CJK ~0.6 tok/char)
function estTokens(s) {
  const str = String(s || '');
  const cjk = (str.match(/[　-鿿가-힯豈-﫿]/g) || []).length;
  return Math.ceil(cjk * 0.6 + (str.length - cjk) * 0.3);
}

export function startServer({ port = 0, capture = !!process.env.CAPTURE, speed = +process.env.SPEED || 1 } = {}) {
  let tr = loadTranslations();
  const captured = existsSync(SEG_FILE) && capture ? JSON.parse(readFileSync(SEG_FILE, 'utf8')) : [];
  const seen = new Set(captured);
  const misses = [];
  const stats = { requests: 0, segs: 0 };
  let reqNo = 0;

  const translate = (s) => {
    if (tr.exact.has(s)) return tr.exact.get(s);
    const loose = tr.loose.get(norm(s));
    // loose match only when the source carries no inline tags (otherwise tags could get lost)
    if (loose && !/<[gx]\d+/.test(s)) return loose;
    misses.push(s);
    if (!capture) console.warn('[replay] missing translation:', JSON.stringify(s).slice(0, 120));
    return s;   // tags preserved, at worst shows the original
  };

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    if (req.method === 'POST' && url.pathname.endsWith('/chat/completions')) {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', async () => {
        const j = JSON.parse(body || '{}');
        const sys = (j.messages.find((m) => m.role === 'system') || {}).content || '';
        const user = (j.messages.find((m) => m.role === 'user') || {}).content || '';
        const isArr = user.trim().startsWith('[');
        const segs = isArr ? JSON.parse(user) : [user];
        stats.requests++; stats.segs += segs.length;
        if (capture) for (const s of segs) if (!seen.has(s)) { seen.add(s); captured.push(s); }
        if (capture) writeFileSync(SEG_FILE, JSON.stringify(captured, null, 2));
        const outs = segs.map(translate);
        const content = isArr ? JSON.stringify(outs) : outs[0];
        // DeepSeek-like usage: the system prompt prefix is served from the provider's disk cache after the first call
        const n = ++reqNo;
        const promptTok = estTokens(sys) + estTokens(user) + 12;
        const hit = n === 1 ? 0 : Math.floor(estTokens(sys) / 64) * 64;
        const usage = { prompt_tokens: promptTok, completion_tokens: estTokens(content) + 2, prompt_cache_hit_tokens: hit, prompt_cache_miss_tokens: promptTok - hit };
        usage.total_tokens = usage.prompt_tokens + usage.completion_tokens;
        const id = 'chatcmpl-demo-' + n;
        const created = Math.floor(Date.now() / 1000);
        const chunk = (delta, extra) => 'data: ' + JSON.stringify(Object.assign({ id, object: 'chat.completion.chunk', created, model: j.model, choices: [{ index: 0, delta, finish_reason: null }] }, extra || {})) + '\n\n';

        if (!j.stream) {
          await sleep(rand(900, 1400) / speed);
          if (res.destroyed) return;
          res.writeHead(200, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ id, object: 'chat.completion', created, model: j.model, choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }], usage }));
        }
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
        res.write(chunk({ role: 'assistant', content: '' }));
        await sleep(rand(520, 720) / speed);                 // time to first token
        let i = 0;
        while (i < content.length) {
          if (res.destroyed || res.writableEnded) return;    // client cancelled (scrolled away)
          const step = Math.round(rand(25, 40));
          res.write(chunk({ content: content.slice(i, i + step) }));
          i += step;
          await sleep(rand(85, 115) / speed);
        }
        if (res.destroyed) return;
        res.write('data: ' + JSON.stringify({ id, object: 'chat.completion.chunk', created, model: j.model, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }) + '\n\n');
        res.write('data: ' + JSON.stringify({ id, object: 'chat.completion.chunk', created, model: j.model, choices: [], usage }) + '\n\n');
        res.end('data: [DONE]\n\n');
      });
      return;
    }
    if (url.pathname === '/__reload') { tr = loadTranslations(); res.writeHead(200); return res.end('ok'); }
    if (url.pathname === '/__stats') { res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ ...stats, misses })); }
    if (url.pathname === '/favicon.ico') { res.writeHead(204); return res.end(); }
    const file = url.pathname === '/' ? 'article.html' : url.pathname.replace(/^\/+/, '').replace(/\.\./g, '');
    try {
      const buf = readFileSync(join(PAGE_DIR, file));
      const type = { '.html': 'text/html; charset=utf-8', '.svg': 'image/svg+xml', '.css': 'text/css' }[extname(file)] || 'application/octet-stream';
      res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-store' });
      res.end(buf);
    } catch (_) { res.writeHead(404); res.end('not found'); }
  });
  return new Promise((resolve) => server.listen(port, '127.0.0.1', () => resolve({
    port: server.address().port, stats, misses, captured, close: () => server.close(),
  })));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const s = await startServer({ port: +process.env.PORT || 8790 });
  console.log(`article: http://127.0.0.1:${s.port}/article.html   endpoint: http://127.0.0.1:${s.port}/v1`);
}
