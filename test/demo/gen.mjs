// 生成确定性的演示页面：固定顶栏、吸顶目录、各种块/行内结构、混排内容、代码块、表格、内部滚动布局
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
let seed = 7;
const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
const pick = (a) => a[Math.floor(rnd() * a.length)];

const S = [
  'Movable type changed how knowledge spread across Europe in the fifteenth century.',
  'Printers experimented with letterforms that balanced legibility against the cost of metal.',
  'A good typeface disappears, letting the reader focus on meaning rather than shape.',
  'The width of a column strongly affects how comfortable a long text is to read.',
  'Early web pages ignored most of these lessons, because screens were coarse and fonts were few.',
  'Responsive layouts reflow text, so the same paragraph can occupy very different heights.',
  'Translators often find that one language needs far more words than another to say the same thing.',
  'Line spacing, or leading, should grow as the measure of a line becomes longer.',
  'Hyphenation helps justified text, but it can also introduce awkward breaks.',
  'Readers scan headings first and then dive into the paragraphs that interest them.',
  'Comparing an original and its translation side by side reveals subtle shifts in tone.',
  'Synchronised scrolling keeps both versions at the same point of the argument.',
];
const sentence = () => pick(S);
const para = (n) => Array.from({ length: n }, sentence).join(' ');
let idx = 0;
const I = () => `data-idx="${idx++}"`;

function article() {
  idx = 0;
  const parts = [];
  parts.push(`<h1 ${I()}>A Short History of Reading on Screens</h1>`);
  parts.push(`<p ${I()} class="lead">This page is a <em>synthetic</em> article for testing <a href="#s1">side-by-side translation</a> with <code>scroll-sync</code>. It mixes many kinds of <strong>inline formatting</strong>.</p>`);
  for (let s = 1; s <= 8; s++) {
    parts.push(`<h2 id="s${s}" ${I()}>Section ${s}: ${pick(['Type and Print', 'Screens and Pixels', 'Layout Rules', 'Reading Habits', 'Translation Notes'])}</h2>`);
    const n = 3 + Math.floor(rnd() * 4);
    for (let i = 0; i < n; i++) {
      const len = 1 + Math.floor(rnd() * 6);
      if (rnd() < 0.3) parts.push(`<p ${I()}>${para(len)} See <a href="https://example.com/${s}-${i}">this reference</a> and the <code>&lt;p&gt;</code> element for details. ${para(1)}</p>`);
      else parts.push(`<p ${I()}>${para(len)}</p>`);
    }
    if (s % 2 === 0) {
      parts.push('<ul>' + Array.from({ length: 4 }, () => `<li ${I()}>${para(1)}</li>`).join('') + '</ul>');
    }
    if (s % 3 === 0) {
      parts.push(`<pre><code>function sync(a, b) {\n  // code blocks are not translated\n  return map(a.scrollTop);\n}\n${'// filler line\n'.repeat(4 + s)}</code></pre>`);
    }
    if (s === 1) {
      // 已是目标语言的段落：不应发送给翻译引擎
      parts.push(`<p lang="zh-CN" ${I()}>这是一段已经是中文的段落，带有 lang 属性，不应该被发送去翻译。</p>`);
      parts.push(`<blockquote><p ${I()}>中文引用：这段没有 lang 属性，靠文字脚本判断出已是目标语言，同样不发送。</p></blockquote>`);
    }
    if (s === 2) {
      parts.push(`<figure><img alt="" width="600" height="220" src="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='600' height='220'%3E%3Crect width='600' height='220' fill='%23cbd5e1'/%3E%3C/svg%3E" style="max-width:100%;height:auto"><figcaption ${I()}>Figure: a placeholder image whose height is the same in both panes.</figcaption></figure>`);
    }
    if (s === 4) {
      parts.push(`<blockquote><p ${I()}>${para(2)}</p></blockquote>`);
      parts.push(`<table><tr><th ${I()}>Language</th><th ${I()}>Relative length</th></tr><tr><td ${I()}>English</td><td>1.00</td></tr><tr><td ${I()}>German</td><td>1.30</td></tr><tr><td ${I()}>Chinese</td><td>0.65</td></tr></table>`);
    }
    if (s === 5) {
      // HN 风格：容器里直接放文字，再跟若干 <p>
      parts.push(`<div class="comment">${para(2)} <a href="https://news.ycombinator.com">a link in a text run</a> ${para(1)}<p ${I()}>${para(2)}</p><p ${I()}>${para(1)}</p></div>`);
    }
  }
  parts.push(`<p ${I()}>The end. ${para(2)}</p>`);
  return parts.join('\n');
}

const css = `
  body { margin: 0; font: 17px/1.65 Georgia, "Times New Roman", serif; color: #222; }
  header.top { position: fixed; top: 0; left: 0; right: 0; height: 52px; background: #0f172a; color: #fff; display: flex; align-items: center; gap: 18px; padding: 0 18px; z-index: 10; font-family: system-ui, sans-serif; }
  header.top a { color: #cbd5e1; text-decoration: none; }
  .layout { display: flex; gap: 32px; max-width: 1100px; margin: 0 auto; padding: 72px 20px 40px; }
  nav.toc { position: sticky; top: 72px; align-self: flex-start; width: 200px; flex: none; font: 14px/1.5 system-ui, sans-serif; }
  nav.toc a { display: block; color: #475569; text-decoration: none; padding: 2px 0; }
  article { flex: 1; min-width: 0; }
  pre { background: #f1f5f9; padding: 12px; overflow: auto; font-size: 14px; }
  code { background: #f1f5f9; padding: 0 3px; border-radius: 3px; }
  table { border-collapse: collapse; } td, th { border: 1px solid #cbd5e1; padding: 4px 10px; }
  blockquote { border-left: 4px solid #cbd5e1; margin: 1em 0; padding-left: 1em; color: #475569; }
  .comment { background: #fafaf9; padding: 10px 14px; border-radius: 6px; }
  @media (max-width: 800px) { nav.toc { display: none; } }
`;
const header = `<header class="top"><b>Typography Weekly</b><a href="#s1">Print</a><a href="#s3">Screens</a><a href="#s5">Reading</a><a id="nav-inner" href="inner-scroll.html">App layout</a></header>`;
const toc = `<nav class="toc"><b>Contents</b>${Array.from({ length: 8 }, (_, i) => `<a href="#s${i + 1}">Section ${i + 1}</a>`).join('')}</nav>`;

const body = article();
writeFileSync(join(here, 'article.html'), `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>A Short History of Reading on Screens</title><style>${css}</style></head><body>${header}<div class="layout">${toc}<article>${body}</article></div></body></html>\n`);

// 应用外壳布局：window 不滚动，内容在 <main> 里滚动（很多文档站 / SPA 是这样）
const css2 = css + `
  html, body { height: 100%; overflow: hidden; }
  .shell { position: absolute; top: 52px; bottom: 0; left: 0; right: 0; display: flex; }
  .shell nav.toc { position: static; padding: 20px; border-right: 1px solid #e2e8f0; overflow: auto; }
  main.scroll { flex: 1; overflow-y: auto; padding: 20px 32px; }
`;
writeFileSync(join(here, 'inner-scroll.html'), `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Inner scroll demo</title><style>${css2}</style></head><body>${header}<div class="shell">${toc}<main class="scroll"><article>${body}</article></main></div></body></html>\n`);
console.log('generated article.html / inner-scroll.html, blocks:', idx);
