/* defaults.js — 设置默认值与语言表（SW / popup / options / content 共用的经典脚本） */
(function (root) {
  'use strict';
  const LANGS = [
    ['zh-CN', '简体中文'], ['zh-TW', '繁體中文'], ['en', 'English'], ['ja', '日本語'],
    ['ko', '한국어'], ['fr', 'Français'], ['de', 'Deutsch'], ['es', 'Español'],
    ['ru', 'Русский'], ['pt', 'Português'], ['it', 'Italiano'], ['ar', 'العربية'],
  ];

  const DEFAULTS = {
    uiLang: 'auto',              // 界面语言：auto（跟随浏览器）/ zh / en
    targetLang: 'zh-CN',
    sourceLang: 'auto',
    activeProviderId: 'deepseek',   // 首次使用：点插件图标填 Key 即可
    highlight: 'hover',          // 'hover' | 'off'
    syncScroll: true,
    stripFrameHeaders: true,     // 分屏期间对该标签页的子框架移除 X-Frame-Options / CSP
    devMode: false,              // 开发者选项：显示 Mock 演示引擎
    prefetchScreens: 0.5,        // 视口下方预翻译的屏数（0 = 只翻可见区域）；上方固定 0.25 屏
    providers: [
      // name 留空 = 显示随界面语言变化的默认名（见 i18n 的 prov.*）
      { id: 'mock', type: 'mock', name: '', latencyMs: 300 },
      {
        id: 'deepseek', type: 'openai', name: '',
        baseUrl: 'https://api.deepseek.com', apiKey: '', model: 'deepseek-flash',
        // 翻译不需要推理：关闭 thinking，实测延迟 5.1s→1.9s、输出 token 约降到 1/6
        temperature: 0.2, extraBody: '{"thinking": {"type": "disabled"}}', systemPrompt: '',
        batchChars: 1500, batchSize: 20, concurrency: 4, timeoutMs: 90000,
      },
      {
        // MiniMax 国内站（platform.minimaxi.com）；国际站 Key 请把地址改成 https://api.minimax.io/v1
        // M3.1 Flash 不允许关闭推理，用 reasoning_effort: low：实测输出 token 508→146、延迟 9.1s→4.5s
        id: 'minimax', type: 'openai', name: '',
        baseUrl: 'https://api.minimaxi.com/v1', apiKey: '', model: 'MiniMax-M3.1-Flash',
        temperature: 0.2, extraBody: '{"reasoning_effort": "low"}', systemPrompt: '',
        batchChars: 1500, batchSize: 20, concurrency: 4, timeoutMs: 90000,
      },
      {
        id: 'local-llm', type: 'openai', name: '',
        baseUrl: 'http://127.0.0.1:8000/v1', apiKey: '', model: 'Qwen/Qwen3-8B',
        temperature: 0.2, extraBody: '', systemPrompt: '',
        batchChars: 2400, batchSize: 24, concurrency: 3, timeoutMs: 90000,
      },
      {
        id: 'deepl', type: 'deepl', name: '',
        endpoint: 'https://api-free.deepl.com', apiKey: '',
        batchChars: 8000, batchSize: 50, concurrency: 2, timeoutMs: 30000,
      },
    ],
  };

  root.PT = root.PT || {};
  root.PT.LANGS = LANGS;
  root.PT.DEFAULTS = DEFAULTS;
  root.PT.langName = (code) => (LANGS.find((l) => l[0] === code) || [code, code])[1];
  /** 引擎显示名：用户起的名字，否则用随界面语言变化的默认名 */
  root.PT.provName = (p) => {
    if (!p) return '';
    if (p.name) return p.name;
    const k = 'prov.' + p.id;
    const t = root.PT.t ? root.PT.t(k) : k;
    return t !== k ? t : p.id;
  };
  /** 这个引擎是否需要 API Key：DeepL 需要；OpenAI 兼容接口指向公网时需要，本机/内网地址（自部署）不强制 */
  root.PT.needsKey = (p) => {
    if (!p || p.type === 'mock') return false;
    if (p.type === 'deepl') return true;
    if (p.type !== 'openai') return false;
    let h = '';
    try { h = new URL(p.baseUrl).hostname; } catch (_) { return false; }
    return !(h === 'localhost' || h.endsWith('.local') || h === '[::1]' || /^127\./.test(h) || /^10\./.test(h) ||
      /^192\.168\./.test(h) || /^172\.(1[6-9]|2\d|3[01])\./.test(h));
  };
  root.PT.hasKey = (p) => !!(p && p.apiKey && String(p.apiKey).trim());
  /** 按浏览器语言猜默认目标语言 */
  root.PT.guessTargetLang = (nav) => {
    const l = String(nav || 'en').toLowerCase();
    if (l.startsWith('zh')) return /tw|hk|mo|hant/.test(l) ? 'zh-TW' : 'zh-CN';
    const p = l.split('-')[0];
    return LANGS.some((x) => x[0] === p) ? p : 'en';
  };
  /** 读取设置并与默认值合并（providers 以存储为准）；顺便设定界面语言 */
  root.PT.loadSettings = async function () {
    const { settings } = await chrome.storage.local.get('settings');
    const s = Object.assign({}, DEFAULTS, settings || {});
    s.providers = JSON.parse(JSON.stringify(s.providers || []));
    // 新版本新增的预设引擎补进老用户的列表（用户主动删过的不再加回来）
    const removed = new Set(s.removedPresets || []);
    const have = new Set(s.providers.map((p) => p.id));
    for (const p of DEFAULTS.providers) if (!have.has(p.id) && !removed.has(p.id)) s.providers.push(JSON.parse(JSON.stringify(p)));
    if (root.PT.i18n) root.PT.i18n.setLang(s.uiLang);
    return s;
  };
  root.PT.saveSettings = async function (patch) {
    const cur = await root.PT.loadSettings();
    const next = Object.assign(cur, patch);
    await chrome.storage.local.set({ settings: next });
    if (root.PT.i18n) root.PT.i18n.setLang(next.uiLang);
    return next;
  };
})(globalThis);
