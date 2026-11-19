/*
 * providers.js — 翻译引擎适配层（SW 中通过 importScripts 加载）。
 *
 * 统一接口： translate(segments: string[], cfg, ctx) => Promise<string[]>
 *   segments 中可能含 <gN>…</gN>、<xN/> 占位标签（行内格式），引擎需原样保留。
 *   ctx = { from, to, page: {title, url}, signal }
 *
 * 新增引擎：在 PT.providers 上加一个 { label, translate } 即可，options 页按 type 渲染表单。
 */
(function (root) {
  'use strict';
  const PT = root.PT;

  const LANG_EN = {
    'zh-CN': 'Simplified Chinese', 'zh-TW': 'Traditional Chinese', en: 'English', ja: 'Japanese',
    ko: 'Korean', fr: 'French', de: 'German', es: 'Spanish', ru: 'Russian', pt: 'Portuguese',
    it: 'Italian', ar: 'Arabic',
  };
  const langEn = (c) => LANG_EN[c] || c;

  class HttpError extends Error {
    constructor(status, msg) { super(msg); this.status = status; }
  }

  async function fetchJson(url, init, timeoutMs, outerSignal) {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(new Error(PT.t('err.timeout', { ms: timeoutMs }))), timeoutMs);
    const onAbort = () => ac.abort(outerSignal.reason);
    if (outerSignal) outerSignal.addEventListener('abort', onAbort, { once: true });
    try {
      const res = await fetch(url, Object.assign({}, init, { signal: ac.signal }));
      const text = await res.text();
      if (!res.ok) throw new HttpError(res.status, `HTTP ${res.status}: ${text.slice(0, 300)}`);
      try { return JSON.parse(text); } catch (_) { throw new HttpError(0, PT.t('err.notJson', { body: text.slice(0, 200) })); }
    } catch (e) {
      if (ac.signal.aborted && ac.signal.reason instanceof Error) throw ac.signal.reason;
      throw e;
    } finally {
      clearTimeout(timer);
      if (outerSignal) outerSignal.removeEventListener('abort', onAbort);
    }
  }

  /** 429 / 5xx / 网络错误 指数退避重试 */
  async function withRetry(fn, signal, tries = 3) {
    let err;
    for (let i = 0; i < tries; i++) {
      try { return await fn(); } catch (e) {
        err = e;
        if (signal && signal.aborted) throw e;           // 被取消：不重试
        const retryable = !(e instanceof HttpError) || e.status === 429 || e.status >= 500;
        if (!retryable || i === tries - 1) throw e;
        await new Promise((r) => setTimeout(r, 800 * 2 ** i));
      }
    }
    throw err;
  }

  /* ----------------------------- LLM 输出解析 ----------------------------- */
  function cleanLLM(text) {
    let t = String(text || '');
    t = t.replace(/<think>[\s\S]*?<\/think>/gi, '');           // Qwen3 / DeepSeek-R1 等推理模型
    t = t.replace(/^\s*```[a-zA-Z]*\s*\n?/, '').replace(/\n?\s*```\s*$/, '');
    return t.trim();
  }
  function parseArray(text, n) {
    const t = cleanLLM(text);
    const i = t.indexOf('['), j = t.lastIndexOf(']');
    if (i < 0 || j <= i) return null;
    let arr;
    try { arr = JSON.parse(t.slice(i, j + 1)); } catch (_) { return null; }
    if (!Array.isArray(arr) || arr.length !== n) return null;
    return arr.map((x) => (typeof x === 'string' ? x : x && (x.text || x.translation) ? String(x.text || x.translation) : String(x)));
  }

  /* ------------------------------ OpenAI 兼容 ------------------------------ */
  // vLLM / SGLang / Ollama(/v1) / LM Studio / llama.cpp server / DeepSeek / 通义 DashScope 兼容模式 / OpenRouter …
  function sysPrompt(cfg, ctx, batch) {
    if (cfg.systemPrompt) {
      return cfg.systemPrompt.replace(/\{to\}/g, langEn(ctx.to)).replace(/\{from\}/g, ctx.from === 'auto' ? 'the source language' : langEn(ctx.from));
    }
    const src = ctx.from === 'auto' ? 'the source language (auto-detect)' : langEn(ctx.from);
    const tgt = langEn(ctx.to);
    const common =
      `- Text may contain inline tags like <g1>…</g1> and <x2/>. Keep every tag exactly (same letter and number) around the corresponding translated words. Never translate, add, drop or renumber tags.\n` +
      `- Keep URLs, code, numbers, units and proper names that should not be translated unchanged. If text is already in ${tgt}, return it unchanged.\n` +
      `- Translate faithfully and fluently for a native ${tgt} reader.\n` +
      (ctx.page && ctx.page.title ? `- Context: this text comes from the web page "${ctx.page.title}".\n` : '');
    if (batch) {
      return `You are a professional translator. Translate each string in the user's JSON array from ${src} into ${tgt}.\n` +
        `Rules:\n- Output ONLY a JSON array of strings with exactly the same number of items and the same order as the input. No comments, no code fences.\n` + common;
    }
    return `You are a professional translator. Translate the user's text from ${src} into ${tgt}.\nRules:\n- Output ONLY the translation, nothing else.\n` + common;
  }

  /** 粗估 token 数：拉丁字母约 0.3 token/字符，中日韩约 0.6 token/字符（DeepSeek 官方经验值） */
  function estTokens(s) {
    const str = String(s || '');
    const cjk = (str.match(/[　-鿿가-힯豈-﫿]/g) || []).length;
    return Math.ceil(cjk * 0.6 + (str.length - cjk) * 0.3);
  }

  // 有些 OpenAI 兼容服务不认 stream_options / max_tokens（返回 400）：记下来，之后对该引擎不再发送。
  // 记在 chrome.storage.session：MV3 的 SW 空闲 30 秒就被回收，只放内存的话几乎每次阅读都要再失败一次
  const unsupported = new Map();   // baseUrl -> Set(param)
  const unsup = (cfg) => unsupported.get(String(cfg.baseUrl || '')) || new Set();
  const sess = root.chrome && chrome.storage && chrome.storage.session;
  const unsupLoaded = sess ? sess.get('unsupParams').then((o) => {
    for (const [k, list] of Object.entries((o && o.unsupParams) || {})) {
      const set = unsupported.get(k) || new Set();
      list.forEach((x) => set.add(x));
      unsupported.set(k, set);
    }
  }).catch(() => {}) : Promise.resolve();
  function markUnsupported(cfg, param) {
    const k = String(cfg.baseUrl || '');
    if (!unsupported.has(k)) unsupported.set(k, new Set());
    unsupported.get(k).add(param);
    if (sess) {
      const all = {};
      for (const [b, set] of unsupported) all[b] = Array.from(set);
      sess.set({ unsupParams: all }).catch(() => {});
    }
  }

  /**
   * 上下文窗口预算（cfg.contextTokens，可选；自部署小模型用）：
   *   一次请求 ≈ 提示词 + 原文 + 译文（中文约为原文 token 的 1～1.5 倍）。超出预算的批次先对半拆开再发，
   *   max_tokens 也不会超过剩余空间 —— 保证请求放得进模型的上下文窗口，而不是发出去被 400 拒掉再重试。
   */
  const ctxBudget = (cfg) => (Number(cfg.contextTokens) > 0 ? Number(cfg.contextTokens) : 0);
  function needTokens(system, user) {
    const inTok = estTokens(system) + estTokens(user) + 16;
    return inTok + Math.ceil(estTokens(user) * 1.5) + 128;
  }

  /**
   * 输出上限：译文长度 ≈ 原文 token 的 1~2 倍，给足余量（含推理模型的思考 token），
   * 只为防止模型"复读"失控时把钱烧光；用户可用 cfg.maxTokens 指定（0 = 不发送）。
   */
  function autoMaxTokens(cfg, user) {
    if (cfg.maxTokens === 0 || cfg.maxTokens === '0') return 0;
    if (Number(cfg.maxTokens) > 0) return Number(cfg.maxTokens);
    return Math.min(8192, Math.max(1024, Math.ceil(estTokens(user) * 2.5) + 512));
  }

  function buildOpenaiRequest(cfg, system, user, stream) {
    let extra = {};
    if (cfg.extraBody && String(cfg.extraBody).trim()) {
      try { extra = JSON.parse(cfg.extraBody); } catch (_) { throw new Error(PT.t('err.extraBody')); }
    }
    const body = {
      model: cfg.model,
      messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
      stream,
    };
    const bad = unsup(cfg);
    // 流式时请服务端在最后一块附上 usage（输入 / 命中缓存 / 输出 token），用于显示真实用量
    if (stream && !bad.has('stream_options')) body.stream_options = { include_usage: true };
    let mt = bad.has('max_tokens') ? 0 : autoMaxTokens(cfg, user);
    const budget = ctxBudget(cfg);
    if (mt && budget) mt = Math.max(256, Math.min(mt, budget - (estTokens(system) + estTokens(user) + 16) - 64));
    if (mt) body.max_tokens = mt;
    Object.assign(body, extra);
    if (cfg.temperature !== '' && cfg.temperature != null && !Number.isNaN(+cfg.temperature)) body.temperature = +cfg.temperature;
    const headers = { 'Content-Type': 'application/json' };
    if (cfg.apiKey) headers.Authorization = `Bearer ${cfg.apiKey}`;
    const url = String(cfg.baseUrl || '').replace(/\/+$/, '') + '/chat/completions';
    return { url, init: { method: 'POST', headers, body: JSON.stringify(body) }, stream: !!body.stream };
  }

  /** 各家 usage 字段归一：DeepSeek 用 prompt_cache_hit_tokens，OpenAI / 多数兼容服务用 prompt_tokens_details.cached_tokens */
  function normUsage(u) {
    if (!u || typeof u !== 'object') return null;
    const inTok = +u.prompt_tokens || 0, outTok = +u.completion_tokens || 0;
    let cached = +u.prompt_cache_hit_tokens || 0;
    if (!cached && u.prompt_tokens_details) cached = +u.prompt_tokens_details.cached_tokens || 0;
    return { inTok, cachedTok: cached, outTok };
  }

  /**
   * 发一次请求。onDelta 存在时走 SSE 流式，每收到一段 content 回调一次；
   * 服务端不支持流式（返回普通 JSON）时自动按非流式处理。返回完整 content。
   * 流式下超时按"多久没收到新数据"计算。
   */
  async function openaiRequestOnce(cfg, ctx, system, user, onDelta) {
    await unsupLoaded;
    for (let k = 0; ; k++) {
      try { return await openaiRequestRaw(cfg, ctx, system, user, onDelta); } catch (e) {
        // 400 且报错里点名了 stream_options / max_tokens / 上下文长度：去掉该参数重试（每个参数只试一次）
        const m = e instanceof HttpError && e.status === 400 ? e.message : '';
        const bad = unsup(cfg);
        if (k < 2 && /stream_options|include_usage/i.test(m) && !bad.has('stream_options')) { markUnsupported(cfg, 'stream_options'); continue; }
        if (k < 2 && /max_tokens|max_completion|context length|maximum context/i.test(m) && !bad.has('max_tokens')) { markUnsupported(cfg, 'max_tokens'); continue; }
        throw e;
      }
    }
  }

  async function openaiRequestRaw(cfg, ctx, system, user, onDelta) {
    const { url, init, stream } = buildOpenaiRequest(cfg, system, user, !!onDelta && cfg.stream !== false);
    const timeoutMs = cfg.timeoutMs || 90000;
    const ac = new AbortController();
    let timer = 0;
    const arm = () => { clearTimeout(timer); timer = setTimeout(() => ac.abort(new Error(PT.t('err.timeout', { ms: timeoutMs }))), timeoutMs); };
    const outer = ctx.signal;
    const onAbort = () => ac.abort(outer.reason);
    if (outer) {
      if (outer.aborted) throw outer.reason || new Error('cancelled');
      outer.addEventListener('abort', onAbort, { once: true });
    }
    let streaming = false, lastUsage = null, full = '';
    arm();
    try {
      const res = await fetch(url, Object.assign({}, init, { signal: ac.signal }));
      if (!res.ok) { const t = await res.text(); throw new HttpError(res.status, `HTTP ${res.status}: ${t.slice(0, 300)}`); }
      const ctype = res.headers.get('content-type') || '';
      if (!stream || !ctype.includes('text/event-stream') || !res.body) {
        const text = await res.text();
        let json;
        try { json = JSON.parse(text); } catch (_) { throw new HttpError(0, PT.t('err.notJson', { body: text.slice(0, 200) })); }
        const msg = json && json.choices && json.choices[0] && json.choices[0].message;
        if (ctx.onUsage) ctx.onUsage(normUsage(json && json.usage) || estUsage(system, user, msg && msg.content));
        if (!msg || typeof msg.content !== 'string') throw new Error(PT.t('err.noContent'));
        if (onDelta) onDelta(msg.content);
        return msg.content;
      }
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = '';
      streaming = true;
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        arm();
        buf += dec.decode(value, { stream: true });
        let nl;
        while ((nl = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, nl).trim();
          buf = buf.slice(nl + 1);
          if (!line.startsWith('data:')) continue;
          const data = line.slice(5).trim();
          if (!data || data === '[DONE]') continue;
          let j;
          try { j = JSON.parse(data); } catch (_) { continue; }
          if (j.error) throw new HttpError(0, String(j.error.message || JSON.stringify(j.error)).slice(0, 300));
          if (j.usage) lastUsage = normUsage(j.usage);   // 有的服务每块都带累计值：只取最后一次
          const ch = j.choices && j.choices[0];
          const piece = ch && ((ch.delta && ch.delta.content) || (ch.message && ch.message.content));
          if (piece) { full += piece; onDelta(piece); }
        }
      }
      return full;
    } catch (e) {
      if (ac.signal.aborted && ac.signal.reason instanceof Error) throw ac.signal.reason;
      throw e;
    } finally {
      clearTimeout(timer);
      if (outer) outer.removeEventListener('abort', onAbort);
      // 流式结束（含被取消）：上报用量。被取消时服务端不再返回 usage，按已收到的输出估算（已生成的部分照样计费）
      if (streaming && ctx.onUsage) ctx.onUsage(lastUsage || estUsage(system, user, full, true));
    }
  }

  function estUsage(system, user, out, partial) {
    return { inTok: estTokens(system) + estTokens(user) + 8, cachedTok: 0, outTok: estTokens(out), est: true, partial: !!partial };
  }

  /** makeOnDelta：每次（重试）尝试都新建一个增量处理器 */
  function openaiCall(cfg, ctx, system, user, makeOnDelta) {
    return withRetry(() => openaiRequestOnce(cfg, ctx, system, user, makeOnDelta ? makeOnDelta() : null), ctx.signal);
  }

  /**
   * 增量解析模型流式输出的 JSON 字符串数组：每闭合一个顶层字符串元素就回调 onItem(k, value)。
   * 跳过 <think>…</think> 与代码块前缀；元素不是字符串（如对象）时不回调，交给最终整体解析。
   */
  function arrayStreamParser(onItem, max) {
    let text = '', pos = 0, started = false, depth = 0, inStr = false, esc = false, strStart = 0, k = 0, done = false;
    function findStart() {
      let from = 0;
      const open = text.lastIndexOf('<think>');
      if (open >= 0) {
        const close = text.indexOf('</think>', open);
        if (close < 0) return false;
        from = close + 8;
      }
      const i = text.indexOf('[', from);
      if (i < 0) return false;
      started = true; depth = 1; pos = i + 1;
      return true;
    }
    function scan() {
      if (!started && !findStart()) return;
      for (; pos < text.length && !done; pos++) {
        const c = text[pos];
        if (inStr) {
          if (esc) esc = false;
          else if (c === '\\') esc = true;
          else if (c === '"') {
            inStr = false;
            if (depth === 1) {
              let v = null;
              try { v = JSON.parse(text.slice(strStart, pos + 1)); } catch (_) { /* 留给最终解析 */ }
              if (typeof v === 'string' && k < max) onItem(k, v);
            }
          }
        } else if (c === '"') { inStr = true; strStart = pos; }
        else if (c === ',' && depth === 1) k++;   // 下标 = 已见过的顶层逗号数，元素是什么类型都对得上
        else if (c === '[' || c === '{') depth++;
        else if (c === ']' || c === '}') { depth--; if (depth === 0) done = true; }
      }
    }
    return { push(piece) { text += piece; if (!done) scan(); } };
  }

  async function openaiTranslate(segments, cfg, ctx) {
    const onItem = typeof ctx.onItem === 'function' ? ctx.onItem : null;
    if (segments.length === 1) {
      const out = cleanLLM(await openaiCall(cfg, ctx, sysPrompt(cfg, ctx, false), segments[0], null));
      return [out];
    }
    const n = segments.length;
    // 放不进上下文窗口：先拆成两半（各自再检查），不发注定失败的请求
    if (ctxBudget(cfg) && needTokens(sysPrompt(cfg, ctx, true), JSON.stringify(segments)) > ctxBudget(cfg)) {
      const mid = Math.ceil(n / 2);
      const sub = (off) => (onItem ? Object.assign({}, ctx, { onItem: (k, v) => onItem(k + off, v) }) : ctx);
      const a = await openaiTranslate(segments.slice(0, mid), cfg, sub(0));
      const b = await openaiTranslate(segments.slice(mid), cfg, sub(mid));
      return a.concat(b);
    }
    const out = await openaiCall(cfg, ctx, sysPrompt(cfg, ctx, true), JSON.stringify(segments),
      onItem ? () => { const p = arrayStreamParser(onItem, n); return (piece) => p.push(piece); } : null);
    const arr = parseArray(out, n);
    if (arr) return arr;
    // 条数对不上 / 不是合法 JSON：二分重试，最终退化为逐条翻译（已经流式显示的段落会被最终结果覆盖）
    if (ctx.signal && ctx.signal.aborted) throw new Error('cancelled');
    const mid = Math.ceil(n / 2);
    const sub = (off) => (onItem ? Object.assign({}, ctx, { onItem: (k, v) => onItem(k + off, v) }) : ctx);
    const a = await openaiTranslate(segments.slice(0, mid), cfg, sub(0));
    const b = await openaiTranslate(segments.slice(mid), cfg, sub(mid));
    return a.concat(b);
  }

  /* --------------------------------- DeepL --------------------------------- */
  function deeplTarget(c) {
    return ({ 'zh-CN': 'ZH-HANS', 'zh-TW': 'ZH-HANT', en: 'EN-US', pt: 'PT-BR' })[c] || c.toUpperCase();
  }
  async function deeplTranslate(segments, cfg, ctx) {
    const body = { text: segments, target_lang: deeplTarget(ctx.to), tag_handling: 'xml' };
    if (ctx.from && ctx.from !== 'auto') body.source_lang = ctx.from.split('-')[0].toUpperCase();
    const url = String(cfg.endpoint || 'https://api-free.deepl.com').replace(/\/+$/, '') + '/v2/translate';
    const json = await withRetry(() => fetchJson(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `DeepL-Auth-Key ${cfg.apiKey}` },
      body: JSON.stringify(body),
    }, cfg.timeoutMs || 30000, ctx.signal), ctx.signal);
    if (!json || !Array.isArray(json.translations) || json.translations.length !== segments.length) throw new Error(PT.t('err.deepl'));
    return json.translations.map((t) => t.text);
  }

  /* ---------------------------------- Mock ---------------------------------- */
  // 离线演示/测试：保留标签，把每段文字重复一遍（制造与原文明显不同的段落高度）
  async function mockTranslate(segments, cfg, ctx) {
    const total = cfg.latencyMs == null ? 300 : +cfg.latencyMs;
    const out = segments.map((s, i) => {
      const parts = s.split(/(<[^>]+>)/);
      const body = parts.map((p) => (p.startsWith('<') || !/\p{L}/u.test(p) ? p : `${p.trim()} ${p.trim()}`)).join('');
      return (i % 3 === 0 ? `【${ctx.to}】` : '') + body;
    });
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    if (typeof ctx.onItem === 'function') {   // 模拟流式：逐条到达
      const step = total / Math.max(1, out.length);
      for (let i = 0; i < out.length; i++) {
        await sleep(step);
        if (ctx.signal && ctx.signal.aborted) throw new Error('cancelled');
        ctx.onItem(i, out[i]);
      }
    } else {
      await sleep(total);
      if (ctx.signal && ctx.signal.aborted) throw new Error('cancelled');
    }
    return out;
  }

  PT.providers = {
    openai: { translate: openaiTranslate },
    deepl: { translate: deeplTranslate },
    mock: { translate: mockTranslate },
  };
  PT.providerUtil = { parseArray, cleanLLM, sysPrompt, arrayStreamParser, estTokens, normUsage, autoMaxTokens, needTokens };
})(globalThis);
