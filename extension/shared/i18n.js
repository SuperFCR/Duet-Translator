/*
 * i18n.js — 界面中英文切换（与浏览器语言无关，由设置 uiLang 决定：auto / zh / en）。
 * 用法：PT.t('key', {var})；HTML 中写 data-i18n / data-i18n-title / data-i18n-ph / data-i18n-html，再调用 PT.i18n.apply(root)。
 * 插件名称与描述在 _locales/ 里，跟随浏览器语言（浏览器限制，无法运行时切换）。
 */
(function (root) {
  'use strict';
  const D = {
    zh: {
      brand: 'Duet · 对读',
      'ui.auto': '自动', 'ui.zh': '中文', 'ui.en': 'English',

      'sh.loading': '加载中…',
      'sh.reloading': '重新翻译中…',
      'sh.lang.title': '目标语言',
      'sh.prov.title': '翻译引擎',
      'sh.sync': '同步滚动',
      'sh.sync.title': '两侧同步滚动',
      'sh.hl.title': '段落对照高亮',
      'hl.hover': '悬停高亮',
      'hl.off': '不高亮',
      'sh.all': '全文',
      'sh.all.title': '翻译整页（默认只翻译可视区域附近）',
      'sh.retry': '重试',
      'sh.retry.title': '重试失败的段落',
      'sh.swap.title': '交换左右',
      'sh.opts.title': '设置',
      'sh.close.title': '关闭对读',
      'sh.confirmAll': '将翻译本页剩余 {n} 段（约 {chars} 字符，已缓存的不计费）。\n默认只翻译可视区域，滚到哪翻到哪。确定翻译全文？',
      'sh.status': '{lang} · 已翻译 {done}/{total} 段 · 本页已请求 {sent} 字符',
      'sh.inflight': ' · 请求中 {n}',
      'sh.failed': ' · 失败 {n}',
      'sh.tip': '未翻译（可见）{n} 段 / {chars} 字符 · 已取消请求 {c}',
      'sh.anchors': ' · 对齐锚点 {n}',

      'err.translate': '翻译失败',
      'err.noKey': '未填写 API Key：点击浏览器工具栏上的插件图标填写',
      'err.noProvider': '未找到当前翻译引擎配置，请在设置页检查',
      'err.unknownType': '未知引擎类型：{type}',
      'err.count': '引擎返回条数不一致',
      'err.timeout': '请求超时（{ms}ms）',
      'err.notJson': '响应不是 JSON：{body}',
      'err.noContent': '响应缺少 choices[0].message.content',
      'err.extraBody': 'extraBody 不是合法 JSON',
      'err.deepl': 'DeepL 响应格式异常',
      'ctx.menu': '对读：从这里开始',

      'pop.on': '在此页开启对读',
      'pop.off': '关闭对读',
      'pop.noTab': '没有可用的标签页',
      'pop.unavailable': '此页面不支持（浏览器内置页 / 商店 / PDF）',
      'pop.engine': '翻译引擎',
      'pop.lang': '目标语言',
      'pop.test': '测试连接',
      'pop.testing': '请求中…',
      'pop.ok': '成功（{ms}ms）：{text}',
      'pop.fail': '失败（{ms}ms）：{text}',
      'pop.saved': '已保存 ✓',
      'pop.keyLocal': 'Key 只保存在本机浏览器',
      'pop.more': '更多设置 ›',
      'pop.show': '显示',
      'pop.hide': '隐藏',
      'pop.mockNote': '离线演示引擎：不调用任何 API，只把原文重复一遍。',

      'f.name': '名称',
      'f.apiKey': 'API Key',
      'f.apiKey.ph': '自部署且无鉴权可留空',
      'f.apiKeyOpt': 'API Key（可空）',
      'f.baseUrl': '接口地址 Base URL',
      'f.baseUrl.ph': 'https://api.deepseek.com 或 http://host:8000/v1',
      'f.baseUrlV1': 'Base URL（到 /v1 为止）',
      'f.model': '模型名',
      'f.temperature': 'temperature（留空则不发送）',
      'f.concurrency': '并发请求数',
      'f.batchSize': '每批最多段数',
      'f.batchChars': '每批最多字符',
      'f.timeoutMs': '超时（ms）',
      'f.extraBody': '额外请求体 JSON（合并进请求）',
      'f.systemPrompt': '自定义 system prompt（可空；支持 {from} {to}）',
      'f.endpoint': 'Endpoint',
      'f.endpoint.ph': 'https://api-free.deepl.com 或 https://api.deepl.com',
      'f.deeplKey': 'Auth Key',
      'f.latencyMs': '模拟延迟（ms）',

      'type.openai': 'OpenAI 兼容', 'type.deepl': 'DeepL', 'type.mock': 'Mock',
      'prov.mock': 'Mock（离线演示）',
      'prov.deepseek': 'DeepSeek V4.1 Flash',
      'prov.local-llm': '自部署 LLM（OpenAI 兼容）',
      'prov.deepl': 'DeepL API',

      'opt.title': 'Duet · 对读 设置',
      'opt.general': '通用',
      'opt.uiLang': '界面语言',
      'opt.source': '源语言',
      'opt.autoDetect': '自动检测',
      'opt.target': '目标语言',
      'opt.active': '当前引擎',
      'opt.highlight': '段落高亮',
      'opt.prefetch': '视口下方预翻译屏数（0 = 只翻可见区）',
      'opt.prefetch.title': '只翻译可视区域及其下方这么多屏；滚动停下后才翻译新位置，快速划过的内容不翻译',
      'opt.sync': '同步滚动',
      'opt.strip': '允许嵌入禁止 iframe 的网站',
      'opt.strip.title': '对读期间，仅对该标签页的子框架移除 X-Frame-Options / CSP 响应头，使禁止嵌入的网站也能分屏',
      'opt.engines': '翻译引擎',
      'opt.engines.hint': 'OpenAI 兼容接口可直接对接 vLLM / SGLang / Ollama（<code>http://host:11434/v1</code>）/ LM Studio / llama.cpp server，以及 DeepSeek、通义（DashScope 兼容模式）、OpenRouter 等。API Key 只保存在本机 <code>chrome.storage.local</code>，只在扩展后台使用。',
      'opt.addOpenai': '+ OpenAI 兼容',
      'opt.addDeepl': '+ DeepL',
      'opt.cache': '缓存',
      'opt.cacheCount': '已缓存 {n} 段译文',
      'opt.cacheNA': '缓存不可用',
      'opt.clearCache': '清除译文缓存',
      'opt.save': '保存',
      'opt.saved': '已保存 ✓',
      'opt.test': '测试',
      'opt.del': '删除',
      'opt.delConfirm': '删除引擎「{name}」？',
      'opt.extraBodyBad': '「{name}」的额外请求体不是合法 JSON',
    },
    en: {
      brand: 'Duet',
      'ui.auto': 'Auto', 'ui.zh': '中文', 'ui.en': 'English',

      'sh.loading': 'Loading…',
      'sh.reloading': 'Re-translating…',
      'sh.lang.title': 'Target language',
      'sh.prov.title': 'Translation engine',
      'sh.sync': 'Sync scroll',
      'sh.sync.title': 'Scroll both panes together',
      'sh.hl.title': 'Paragraph highlight',
      'hl.hover': 'Highlight on hover',
      'hl.off': 'No highlight',
      'sh.all': 'Whole page',
      'sh.all.title': 'Translate the whole page (by default only what is near the screen)',
      'sh.retry': 'Retry',
      'sh.retry.title': 'Retry failed paragraphs',
      'sh.swap.title': 'Swap sides',
      'sh.opts.title': 'Settings',
      'sh.close.title': 'Close Duet',
      'sh.confirmAll': 'Translate the remaining {n} paragraphs on this page (about {chars} characters; cached ones are free)?\nBy default Duet only translates what you scroll to.',
      'sh.status': '{lang} · {done}/{total} paragraphs translated · {sent} chars sent',
      'sh.inflight': ' · {n} in flight',
      'sh.failed': ' · {n} failed',
      'sh.tip': 'Untranslated (visible): {n} paragraphs / {chars} chars · cancelled requests: {c}',
      'sh.anchors': ' · {n} alignment anchors',

      'err.translate': 'Translation failed',
      'err.noKey': 'No API key: click the extension icon in the toolbar to enter one',
      'err.noProvider': 'Active translation engine not found; check the settings page',
      'err.unknownType': 'Unknown engine type: {type}',
      'err.count': 'The engine returned a different number of items',
      'err.timeout': 'Request timed out ({ms} ms)',
      'err.notJson': 'Response is not JSON: {body}',
      'err.noContent': 'Response is missing choices[0].message.content',
      'err.extraBody': 'extraBody is not valid JSON',
      'err.deepl': 'Unexpected DeepL response format',
      'ctx.menu': 'Duet: read side by side from here',

      'pop.on': 'Read this page side by side',
      'pop.off': 'Close Duet',
      'pop.noTab': 'No active tab',
      'pop.unavailable': 'Not available here (browser pages / store / PDF)',
      'pop.engine': 'Translation engine',
      'pop.lang': 'Target language',
      'pop.test': 'Test connection',
      'pop.testing': 'Requesting…',
      'pop.ok': 'OK ({ms} ms): {text}',
      'pop.fail': 'Failed ({ms} ms): {text}',
      'pop.saved': 'Saved ✓',
      'pop.keyLocal': 'Keys stay in this browser only',
      'pop.more': 'More settings ›',
      'pop.show': 'Show',
      'pop.hide': 'Hide',
      'pop.mockNote': 'Offline demo engine: calls no API and just repeats the original text.',

      'f.name': 'Name',
      'f.apiKey': 'API key',
      'f.apiKey.ph': 'Leave empty for self-hosted servers without auth',
      'f.apiKeyOpt': 'API key (optional)',
      'f.baseUrl': 'Base URL',
      'f.baseUrl.ph': 'https://api.deepseek.com or http://host:8000/v1',
      'f.baseUrlV1': 'Base URL (up to /v1)',
      'f.model': 'Model',
      'f.temperature': 'temperature (leave empty to omit)',
      'f.concurrency': 'Concurrent requests',
      'f.batchSize': 'Max paragraphs per batch',
      'f.batchChars': 'Max characters per batch',
      'f.timeoutMs': 'Timeout (ms)',
      'f.extraBody': 'Extra request body JSON (merged into each request)',
      'f.systemPrompt': 'Custom system prompt (optional; supports {from} {to})',
      'f.endpoint': 'Endpoint',
      'f.endpoint.ph': 'https://api-free.deepl.com or https://api.deepl.com',
      'f.deeplKey': 'Auth key',
      'f.latencyMs': 'Simulated latency (ms)',

      'type.openai': 'OpenAI-compatible', 'type.deepl': 'DeepL', 'type.mock': 'Mock',
      'prov.mock': 'Mock (offline demo)',
      'prov.deepseek': 'DeepSeek V4.1 Flash',
      'prov.local-llm': 'Self-hosted LLM (OpenAI-compatible)',
      'prov.deepl': 'DeepL API',

      'opt.title': 'Duet Settings',
      'opt.general': 'General',
      'opt.uiLang': 'Interface language',
      'opt.source': 'Source language',
      'opt.autoDetect': 'Auto-detect',
      'opt.target': 'Target language',
      'opt.active': 'Active engine',
      'opt.highlight': 'Paragraph highlight',
      'opt.prefetch': 'Screens to pre-translate below the viewport (0 = visible area only)',
      'opt.prefetch.title': 'Only the visible area plus this many screens below it are translated. New positions are translated once scrolling stops; content you fly past is skipped.',
      'opt.sync': 'Sync scroll',
      'opt.strip': 'Allow sites that forbid iframes',
      'opt.strip.title': 'While Duet is open, strip X-Frame-Options / CSP response headers for that tab\'s frames only, so sites that forbid embedding can still be split',
      'opt.engines': 'Translation engines',
      'opt.engines.hint': 'The OpenAI-compatible type works with vLLM / SGLang / Ollama (<code>http://host:11434/v1</code>) / LM Studio / llama.cpp server, as well as DeepSeek, Qwen (DashScope compatible mode), OpenRouter and more. API keys are kept only in this browser\'s <code>chrome.storage.local</code> and used only by the extension background.',
      'opt.addOpenai': '+ OpenAI-compatible',
      'opt.addDeepl': '+ DeepL',
      'opt.cache': 'Cache',
      'opt.cacheCount': '{n} translations cached',
      'opt.cacheNA': 'Cache unavailable',
      'opt.clearCache': 'Clear translation cache',
      'opt.save': 'Save',
      'opt.saved': 'Saved ✓',
      'opt.test': 'Test',
      'opt.del': 'Delete',
      'opt.delConfirm': 'Delete engine "{name}"?',
      'opt.extraBodyBad': 'The extra request body of "{name}" is not valid JSON',
    },
  };

  let lang = 'en';
  function resolve(pref) {
    if (pref === 'zh' || pref === 'en') return pref;
    const nav = (root.navigator && root.navigator.language) || 'en';
    return /^zh/i.test(nav) ? 'zh' : 'en';
  }
  function setLang(pref) { lang = resolve(pref); return lang; }
  /** 未提供的变量保持 {原样}（如 system prompt 说明里的 {from} {to}） */
  function t(key, vars) {
    let s = D[lang][key];
    if (s == null) s = D.en[key];
    if (s == null) return key;
    if (vars) s = s.replace(/\{(\w+)\}/g, (m, k) => (vars[k] == null ? m : String(vars[k])));
    return s;
  }
  function apply(rootEl) {
    for (const e of rootEl.querySelectorAll('[data-i18n]')) e.textContent = t(e.dataset.i18n);
    for (const e of rootEl.querySelectorAll('[data-i18n-html]')) e.innerHTML = t(e.dataset.i18nHtml);   // 仅限本文件内的可信字符串
    for (const e of rootEl.querySelectorAll('[data-i18n-title]')) e.title = t(e.dataset.i18nTitle);
    for (const e of rootEl.querySelectorAll('[data-i18n-ph]')) e.placeholder = t(e.dataset.i18nPh);
  }
  const fmtNum = (n) => (n == null ? '?' : Number(n).toLocaleString(lang === 'zh' ? 'zh-CN' : 'en-US'));

  root.PT = root.PT || {};
  root.PT.i18n = { t, setLang, apply, fmtNum, resolve, get lang() { return lang; } };
  root.PT.t = t;
})(globalThis);
