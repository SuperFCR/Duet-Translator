# Site compatibility · 网站兼容性

Results of `test/e2e/compat.mjs`: each site is opened, split, translated with the offline Mock engine (no API calls), scrolled 7 × 650 px on the left, and closed. The sync error is measured independently in each pane's own DOM: the paragraph under the left pane's focus line must sit at the same relative position under the right pane's focus line.

`test/e2e/compat.mjs` 的结果：逐个打开网站 → 分屏 → 用离线 Mock 引擎翻译（不调用 API）→ 在左侧滚动 7 次、每次 650 px → 关闭。对齐误差在两侧各自的 DOM 里独立测量：左侧焦点线所在段落，在右侧焦点线处应处于同样的相对位置。

Environment / 环境：Chromium 159 (Chrome for Testing, headless), 1400×900, 2026-11-18. Not yet verified in Edge itself / 尚未在 Edge 本体上验证。

## Content sites / 内容站点

| Site | Split | Translation | Max sync error | Close restores | Notes |
|---|---|---|---|---|---|
| Wikipedia (en) | ✅ | ✅ | 0 px | ✅ | Floats, infobox, captions beside text — handled by side-by-side filtering |
| Wikipedia (zh → en) | ✅ | ✅ | 0 px | ✅ | CJK source |
| GitHub repository / README | ✅ | ✅ | 0 px | ✅ | Sends `X-Frame-Options: deny`; handled by the per-tab header rule |
| GitHub Docs | ✅ | ✅ | 1 px | ✅ | |
| MDN | ✅ | ✅ | 0 px | ✅ | |
| Python docs | ✅ | ✅ | 1 px | ✅ | Code blocks untouched |
| React docs (Next.js) | ✅ | ✅ | 0 px | ✅ | Client-side app |
| Hacker News | ✅ | ✅ | 0 px | ✅ | Table layout, comment text mixed with `<p>` |
| arXiv paper (ar5iv HTML) | ✅ | ✅ | 0 px | ✅ | MathML formulas and section numbers kept as-is |

Before the side-by-side filtering (see DESIGN.md §5.1) the error on English Wikipedia was up to 292 px and on Chinese Wikipedia up to 185 px.

加入"并排元素过滤"（见 DESIGN.md §5.1）之前，英文维基百科的误差最高 292 px，中文维基百科最高 185 px。

## Known problem cases / 已知问题

| Site | What happens | Workaround / status |
|---|---|---|
| The Guardian (and other sites with a cookie-consent dialog) | The dialog appears in **both** panes and blocks scrolling until accepted | Accept it in each pane. 两侧各点一次同意 |
| Medium | The panes get a **Cloudflare security check** (the page itself loads fine). The article redirects to a subdomain, so inside the pane it becomes cross-origin and the check may never pass | The top bar now says the site's bot protection blocked the split view; close Duet to read normally. 顶栏会明确提示 |
| Stack Overflow, Reddit, BBC | Blocked by the site or the network **in this headless test environment** (403 / block page / connection closed) | Unknown in a normal browser; needs manual testing. 在普通浏览器中的表现待人工验证 |

## Fixed while testing / 测试中修复的问题

- **Side-by-side elements bent the alignment** (floated images and captions, infobox rows, table cells in one row, multi-column cards): their anchors were inserted inside body paragraphs. Now only the element with the most text in each vertically overlapping group is used.
- **Runaway re-translation**: when a page rewrote already-translated text (framework re-render, appended status text), the mixed text could be translated again and again, each time costing API calls. Now a paragraph is re-translated only if the page restored new source text, at most twice; cached text is free.
- **Bot-check pages** in a pane are detected and explained in the top bar.

- **并排元素把对齐带偏**：浮动图片和图注、信息框行、表格同一行的单元格、多栏卡片的锚点插进了正文段落内部。现在每组竖直重叠的元素只用文字最多的那个。
- **死循环重译**：页面改写已翻译的文字（框架重渲染、追加状态文字）时，混合后的文字会被一遍遍重译，每次都花 API 费用。现在只有页面换回了新的原文才重译，每段最多两次；缓存命中不计费。
- 窗格里出现**反爬虫验证页**时，顶栏会明确说明原因。

## Run it yourself / 自己运行

```bash
cd test
node e2e/compat.mjs              # all sites
node e2e/compat.mjs github mdn   # only sites whose name contains these words
```

Screenshots and `compat.json` are written to `test/e2e/out/compat/`.
