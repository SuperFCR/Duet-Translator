// 生成确定性的论坛讨论页（HN / Reddit 风格）：~150 条嵌套评论，每条都带重复的界面短串
// （用户名、"3 hours ago"、reply / share / report / permalink），用于衡量重复段落的处理。
//   node bench/gen-forum.mjs   →  bench/pages/forum.html
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

export function genForum(nComments = 150) {
  let seed = 20261119;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  const pick = (a) => a[Math.floor(rnd() * a.length)];

  const USERS = ['quietbyte', 'lambda_lynx', 'oldschoolsysadmin', 'nullpointer_ex', 'gopher_jane', 'tabs_not_spaces',
    'heisenbug', 'cachemiss', 'ferrous_oxide', 'mkb_dev', 'throwaway_8812', 'segfault_sam', 'pixelpusher', 'yak_shaver',
    'bitflip', 'deadlock_dan', 'monad_mia', 'kernelpanic', 'latency_hawk', 'mutable_state', 'unicode_ursula', 'trie_hard',
    'sudo_sandwich', 'off_by_one', 'greybeard77', 'async_amy', 'ok_boomer_dev', 'rubberduck', 'zero_cost', 'linker_error'];
  const AGES = ['1 hour ago', '2 hours ago', '3 hours ago', '4 hours ago', '5 hours ago', '7 hours ago', '9 hours ago', '12 hours ago', '1 day ago'];
  const SENT = [
    'I tried something similar last year and the hardest part was keeping both versions aligned while scrolling.',
    'Machine translation has become good enough that I read most foreign news this way now.',
    'The real problem is cost: translating every page in full burns tokens on content nobody reads.',
    'Caching by paragraph hash is the obvious move, but it breaks as soon as the site re-renders.',
    'Side-by-side view is underrated for language learners, because you can glance at the original when something sounds off.',
    'Honestly, I would pay for this if it worked reliably on single-page apps.',
    'How does it handle inline links and code? Most tools I have used just flatten everything into plain text.',
    'This is exactly what I wanted when reading papers in a language I only half understand.',
    'Latency matters more than people think; if the translation lags behind my scrolling I stop using it.',
    'We built an internal tool like this and the biggest win was not translating navigation menus over and over.',
    'Streaming the result paragraph by paragraph makes it feel much faster even if the total time is the same.',
    'I am skeptical that small models keep the formatting tags intact under load.',
    'Prompt caching changed the economics for us; the system prompt is basically free after the first request.',
    'The comment threads are the worst case, since half of the text is the same buttons repeated a hundred times.',
    'Does it work with pages that use an inner scrolling container instead of the window?',
    'Please add a keyboard shortcut to toggle the split; reaching for the mouse breaks my reading flow.',
    'My experience is the opposite: full-page translation up front is less distracting than text appearing as I scroll.',
    'One thing I would love is a way to pin the glossary for technical terms so they are translated consistently.',
    'The extension asked for access to all sites, which is a hard no at my company.',
    'I wonder how it compares with the built-in browser translator in terms of quality.',
    'For long articles the scroll sync is the killer feature; everything else is a nice bonus.',
    'Translating only what is on screen seems like a clever trade-off between speed and cost.',
    'Some sites block framing entirely, so I am curious how the split view deals with that.',
    'The model occasionally returns fewer items than it was given, so the client must be defensive.',
    'Batching too many paragraphs into one request makes the first screen noticeably slower.',
    'I would rather it waited a moment after I stop scrolling than fire requests while I am flicking through.',
    'This thread is a good stress test, ironically.',
    'Somebody should benchmark the token usage of these tools; my guess is most of it is wasted.',
    'Keep the original on the left and the translation on the right, it just matches how people read.',
    'Is there a self-hosted option? I already run a local model for this kind of thing.',
    'The pricing difference between cached and uncached input is large enough to design around.',
    'Back in the day we used bilingual printed editions for exactly the same reason.',
    'If it can keep the code blocks untouched, I would use it for documentation every day.',
    'Great work, the demo is impressively smooth on my old laptop.',
    'I am not convinced that output length scales the way the author claims for Japanese.',
    'You can probably dedupe identical strings before sending them, which would help a lot on forums.',
  ];
  const SHORT = ['This.', 'Thanks for sharing!', 'Came here to say exactly this.', 'Same experience here.', 'Great write-up, thanks.', '[deleted]', '+1, would love this.'];
  const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;');

  const comments = [];
  let depth = 0;
  for (let i = 0; i < nComments; i++) {
    if (i === 0) depth = 0;
    else { const r = rnd(); depth = r < 0.35 ? 0 : r < 0.75 ? Math.min(depth + 1, 4) : Math.max(0, depth - 1); }
    const user = pick(USERS), age = pick(AGES), pts = 1 + Math.floor(rnd() * 120);
    let body;
    if (rnd() < 0.12) body = `<p>${esc(pick(SHORT))}</p>`;
    else {
      const np = 1 + Math.floor(rnd() * 3);
      body = Array.from({ length: np }, () => `<p>${Array.from({ length: 1 + Math.floor(rnd() * 3) }, () => esc(pick(SENT))).join(' ')}</p>`).join('');
    }
    comments.push(`<div class="c" id="c${i}" style="margin-left:${depth * 22}px">
<div class="meta"><a class="user" href="#u-${user}">${user}</a><span class="pts">${pts} points</span><div class="age"><a href="#c${i}">${age}</a></div><span class="toggle">[–]</span></div>
<div class="body">${body}</div>
<ul class="actions"><li><a href="#r${i}">reply</a></li><li><a href="#s${i}">share</a></li><li><a href="#x${i}">report</a></li><li><a href="#c${i}">permalink</a></li></ul>
</div>`);
  }

  const css = `
  body { margin: 0; font: 15px/1.5 Verdana, Geneva, sans-serif; color: #222; background: #f6f6ef; }
  .top { background: #ff6600; padding: 6px 12px; display: flex; gap: 12px; align-items: center; font-size: 14px; }
  .top b { color: #000; } .top a { color: #000; text-decoration: none; }
  main { max-width: 1000px; margin: 0 auto; padding: 12px 16px 60px; }
  h1 { font-size: 20px; margin: 10px 0 4px; }
  .sub { color: #828282; font-size: 13px; }
  .story p { margin: 10px 0; }
  .sort { margin: 16px 0 8px; color: #828282; font-size: 13px; }
  .c { margin-top: 14px; padding-left: 8px; border-left: 2px solid #e0e0d0; }
  .meta { color: #828282; font-size: 12px; display: flex; gap: 8px; align-items: baseline; }
  .meta a { color: #828282; } .meta .user { color: #3c5a7a; font-weight: bold; text-decoration: none; }
  .age { display: inline-block; }
  .body p { margin: 4px 0; }
  ul.actions { list-style: none; padding: 0; margin: 2px 0 0; display: flex; gap: 12px; font-size: 12px; }
  ul.actions a { color: #828282; text-decoration: underline; }
  footer { color: #828282; font-size: 12px; text-align: center; padding: 20px; }
`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Ask Forum: Do you read foreign-language pages with side-by-side translation?</title><style>${css}</style></head><body>
<div class="top"><b>Hacker Forum</b><a href="#">new</a><a href="#">past</a><a href="#">comments</a><a href="#">ask</a><a href="#">show</a><a href="#">jobs</a><a href="#">submit</a></div>
<main>
<div class="story">
<h1>Ask Forum: Do you read foreign-language pages with side-by-side translation?</h1>
<div class="sub">412 points by polyglot_pat 14 hours ago | hide | past | favorite | ${nComments} comments</div>
<p>I have been using a split-view translator for a few weeks: the original page on the left, the translation on the right, scrolled in sync. It translates only what is on screen, which keeps the bill small, but I keep wondering how much is still wasted on repeated interface text.</p>
<p>Curious how others handle this. Do you translate whole pages up front, or only the parts you actually read? And does anyone measure the token cost?</p>
</div>
<div class="sort">Sort by: <a href="#">top</a> | <a href="#">new</a> | <a href="#">controversial</a></div>
${comments.join('\n')}
<footer>Guidelines | FAQ | Lists | API | Security | Legal | Contact</footer>
</main></body></html>
`;
}

export function writeForum(dir = join(here, 'pages')) {
  mkdirSync(dir, { recursive: true });
  const file = join(dir, 'forum.html');
  writeFileSync(file, genForum());
  return file;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) console.log('wrote', writeForum());
