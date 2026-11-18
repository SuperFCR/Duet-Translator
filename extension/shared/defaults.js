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
  /** 读取设置并与默认值合并（providers 以存储为准）；顺便设定界面语言 */
  root.PT.loadSettings = async function () {
    const { settings } = await chrome.storage.local.get('settings');
    const s = Object.assign({}, DEFAULTS, settings || {});
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
