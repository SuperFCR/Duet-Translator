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

  async function openaiCall(cfg, ctx, system, user) {
    let extra = {};
    if (cfg.extraBody && String(cfg.extraBody).trim()) {
      try { extra = JSON.parse(cfg.extraBody); } catch (_) { throw new Error(PT.t('err.extraBody')); }
    }
    const body = Object.assign({
      model: cfg.model,
      messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
      stream: false,
    }, extra);
    if (cfg.temperature !== '' && cfg.temperature != null && !Number.isNaN(+cfg.temperature)) body.temperature = +cfg.temperature;
    const headers = { 'Content-Type': 'application/json' };
    if (cfg.apiKey) headers.Authorization = `Bearer ${cfg.apiKey}`;
    const url = String(cfg.baseUrl || '').replace(/\/+$/, '') + '/chat/completions';
    const json = await withRetry(() => fetchJson(url, { method: 'POST', headers, body: JSON.stringify(body) }, cfg.timeoutMs || 90000, ctx.signal), ctx.signal);
    const msg = json && json.choices && json.choices[0] && json.choices[0].message;
    if (!msg || typeof msg.content !== 'string') throw new Error(PT.t('err.noContent'));
    return msg.content;
  }

  async function openaiTranslate(segments, cfg, ctx) {
    if (segments.length === 1) {
      const out = await openaiCall(cfg, ctx, sysPrompt(cfg, ctx, false), segments[0]);
      return [cleanLLM(out)];
    }
    const out = await openaiCall(cfg, ctx, sysPrompt(cfg, ctx, true), JSON.stringify(segments));
    const arr = parseArray(out, segments.length);
    if (arr) return arr;
    // 条数对不上 / 不是合法 JSON：二分重试，最终退化为逐条翻译
    if (ctx.signal && ctx.signal.aborted) throw new Error('cancelled');
    const mid = Math.ceil(segments.length / 2);
    const a = await openaiTranslate(segments.slice(0, mid), cfg, ctx);
    const b = await openaiTranslate(segments.slice(mid), cfg, ctx);
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
    await new Promise((r) => setTimeout(r, cfg.latencyMs == null ? 300 : +cfg.latencyMs));
    if (ctx.signal && ctx.signal.aborted) throw new Error('cancelled');
    return segments.map((s, i) => {
      const parts = s.split(/(<[^>]+>)/);
      const body = parts.map((p) => (p.startsWith('<') || !/\p{L}/u.test(p) ? p : `${p.trim()} ${p.trim()}`)).join('');
      return (i % 3 === 0 ? `【${ctx.to}】` : '') + body;
    });
  }

  PT.providers = {
    openai: { translate: openaiTranslate },
    deepl: { translate: deeplTranslate },
    mock: { translate: mockTranslate },
  };
  PT.providerUtil = { parseArray, cleanLLM, sysPrompt };
})(globalThis);
