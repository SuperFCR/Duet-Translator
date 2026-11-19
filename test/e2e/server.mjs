// 本地测试服务器：演示页面 + 带 X-Frame-Options: DENY 的页面 + 假的 OpenAI 兼容接口
import http from 'node:http';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const demo = join(here, '..', 'demo');

// 假"翻译"：标签外的英文单词换成更短的伪中文（译文比原文短，和 Mock 引擎相反）
export function fakeTranslate(s) {
  return '译:' + s.split(/(<[^>]+>)/).map((p) => (p.startsWith('<') ? p :
    p.replace(/[A-Za-z]+/g, (w) => '文'.repeat(Math.max(1, Math.ceil(w.length / 3)))))).join('');
}

export function startServer(port = 0) {
  const requests = [];
  const stats = { requests: 0, segs: 0, aborted: 0 };
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    const slow = url.pathname === '/slow/v1/chat/completions';   // 模拟慢模型：便于测试"划走后取消"
    const drip = url.pathname === '/drip/v1/chat/completions';   // 流式逐条慢慢吐：便于测试"翻好一段显示一段"
    const auth = url.pathname === '/auth/v1/chat/completions';   // 需要 Authorization 头，否则 401
    // 模拟 Key 与平台不匹配（MiniMax 风格的 2049）与"该模型不允许关闭推理"（400）
    if (req.method === 'POST' && url.pathname === '/badkey/v1/chat/completions') {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      return res.end('{"type":"error","error":{"type":"authorized_error","message":"invalid api key (2049)","http_code":"401"}}');
    }
    if (req.method === 'POST' && url.pathname === '/think400/v1/chat/completions') {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      return res.end('{"type":"error","error":{"type":"bad_request_error","message":"invalid params, model requires adaptive thinking; thinking.type=\\"disabled\\" is not allowed (2013)"}}');
    }
    if (req.method === 'POST' && auth && !req.headers.authorization) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      return res.end('{"error":{"message":"Authentication Fails, no api key"}}');
    }
    if (req.method === 'POST' && (slow || drip || auth || url.pathname === '/v1/chat/completions')) {
      res.on('close', () => { if (!res.writableEnded) stats.aborted++; });
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => {
        const j = JSON.parse(body);
        requests.push(j);
        const user = j.messages.find((m) => m.role === 'user').content;
        stats.requests++;
        stats.segs += user.trim().startsWith('[') ? JSON.parse(user).length : 1;
        let content;
        if (user.trim().startsWith('[')) {
          // 模拟推理模型 + 代码块包裹，检验解析的鲁棒性
          content = '<think>planning…</think>\n```json\n' + JSON.stringify(JSON.parse(user).map(fakeTranslate)) + '\n```';
        } else content = fakeTranslate(user);
        const total = slow ? 2500 : 150;
        if (j.stream) {
          // SSE：按"每个数组元素"切块逐步发送，drip 模式每个元素 400ms
          const isArr = user.trim().startsWith('[');
          const items = isArr ? JSON.parse(user).map(fakeTranslate) : [content];
          const pieces = [];
          if (isArr) {
            pieces.push('<think>planning…</think>\n```json\n[');
            items.forEach((it, i) => pieces.push((i ? ',' : '') + JSON.stringify(it)));
            pieces.push(']\n```');
          } else pieces.push(content);
          const step = drip ? 400 : total / pieces.length;
          res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
          let k = 0;
          const tick = () => {
            if (res.destroyed || res.writableEnded) return;
            if (k >= pieces.length) { res.end('data: [DONE]\n\n'); return; }
            res.write('data: ' + JSON.stringify({ choices: [{ delta: { content: pieces[k++] } }] }) + '\n\n');
            setTimeout(tick, step);
          };
          setTimeout(tick, step);
          return;
        }
        setTimeout(() => {
          if (res.destroyed || res.writableEnded) return;
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content } }] }));
        }, total);
      });
      return;
    }
    if (url.pathname === '/favicon.ico') { res.writeHead(204); return res.end(); }
    if (url.pathname === '/__stats') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify(stats));
    }
    if (url.pathname === '/__requests') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify(requests));
    }
    let file = url.pathname === '/' ? '/article.html' : url.pathname;
    const headers = { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' };
    if (file === '/deny.html') {
      file = '/article.html';
      headers['X-Frame-Options'] = 'DENY';
      headers['Content-Security-Policy'] = "frame-ancestors 'none'";
    }
    try {
      const buf = readFileSync(join(demo, file.replace(/\.\./g, '')));
      res.writeHead(200, headers);
      res.end(buf);
    } catch (_) {
      res.writeHead(404); res.end('not found');
    }
  });
  return new Promise((resolve) => server.listen(port, '127.0.0.1', () => {
    resolve({ port: server.address().port, requests, close: () => server.close() });
  }));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { port } = await startServer(+process.env.PORT || 8787);
  console.log(`demo: http://127.0.0.1:${port}/article.html  (deny.html / inner-scroll.html)`);
  console.log(`fake OpenAI-compatible endpoint: http://127.0.0.1:${port}/v1`);
}
