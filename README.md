<p align="center"><img src="extension/icons/logo.svg" width="112" alt="Duet-Translator logo"></p>

<h1 align="center">Duet-Translator</h1>

<p align="center"><b>English</b> | <a href="README.zh-CN.md">简体中文</a></p>

Duet-Translator is an Edge / Chrome extension that shows a web page and its translation **side by side**, and keeps the two panes scrolling **in sync, paragraph by paragraph**. You bring the translation engine: a self-hosted LLM (vLLM, SGLang, Ollama…), a hosted API such as DeepSeek, or DeepL.

![Duet-Translator demo: the split view opens, the translation streams in, both panes scroll in sync, hovering highlights the matching paragraph, and a revisit fills instantly from the cache](docs/images/demo.gif)

<sub>Demo recording: an original sample article; the translations were written in advance and replayed by a local engine so the recording is reproducible.</sub>

## Features

- **The real page, twice.** Both panes load the actual page, so layout, images, links and login state stay intact. Only the right pane is translated, in place.
- **Paragraph-aligned scrolling.** Scroll either side and the other follows; the paragraph you are reading lines up on both sides, and both reach the top and bottom together, even when the translation is much longer or shorter than the original.
- **Pay only for what you read.** Only the visible area (plus half a screen) is translated. Nothing is requested while you scroll, requests you scrolled away from are cancelled, and duplicate paragraphs are sent once.
- **Cache-first.** Everything you have read is kept locally and shown instantly, even while you scroll; the prompt is laid out so providers with prefix caching (DeepSeek, OpenAI…) bill most of the instructions at the cached rate. A green meter shows this page's tokens, cache hits and estimated cost.
- **Streaming.** Long paragraphs fill in word by word as they are generated, and jumping around never leaves the spot you land on waiting behind requests for places you have already left.
- **Formatting preserved.** Links, bold/italic, inline code, citation markers and images survive translation; code blocks are left untouched.
- **Bring your own engine.** Any OpenAI-compatible endpoint (vLLM, SGLang, Ollama, LM Studio, llama.cpp, DeepSeek, OpenRouter, Qwen/DashScope…) or DeepL.
- **Hover to compare.** Hovering a paragraph highlights its counterpart on the other side.
- **Chinese / English interface**, switchable at any time.

![Duet-Translator: English Wikipedia on the left, Chinese translation on the right](docs/images/screenshot-en.png)

<sub>Screenshot: the English Wikipedia article "Typography" (CC BY-SA), translated by DeepSeek V4.1 Flash. The highlighted paragraph is the same one on both sides.</sub>

## Install

Duet-Translator is not on the extension stores yet; load it from source:

1. Download or clone this repository.
2. Open `edge://extensions` (or `chrome://extensions`) and turn on **Developer mode**.
3. Click **Load unpacked** (not "Pack extension") and select the **`extension/`** folder — the one that directly contains `manifest.json`.
4. Pin the Duet-Translator icon from the extensions (puzzle-piece) menu.

After pulling new code, click **Reload** on the extension card and refresh the page.

> Edge derives the ID of an unpacked extension from its folder path. If you move the folder, Edge treats it as a new extension and you will need to enter your API key again.

## Set up an engine

<img src="docs/images/popup-en.png" width="320" align="right" alt="Duet-Translator popup">

After installation a **welcome page** opens and walks you through pinning the icon, choosing an engine and entering a key, then opens a sample page with Duet already on. You can also set things up any time from the Duet-Translator icon in the toolbar:

1. Choose a **translation engine** (DeepSeek V4.1 Flash by default).
2. Paste your **API key**, and change the base URL or model if needed. Changes are saved automatically.
3. Click **Test connection**.
4. Click **Read this page side by side**.

If the engine needs a key and none is set, Duet asks for it right there instead of opening the split view. Changes apply immediately to a page that is already open: after you enter a key, failed paragraphs are retried; after switching engine or target language, the right pane is re-translated.

Batch size, concurrency, extra request parameters, a custom prompt and additional engines live under **More settings**.

<br clear="right">

### Engine presets

| Engine | What to fill in |
|---|---|
| DeepSeek V4.1 Flash | API key only. Base URL `https://api.deepseek.com`, model `deepseek-flash`, with `{"thinking": {"type": "disabled"}}` preset |
| MiniMax M3.1 Flash | API key only. Base URL `https://api.minimaxi.com/v1` for keys from the China site (platform.minimaxi.com); change it to `https://api.minimax.io/v1` for international keys (platform.minimax.io). Keys do not work across the two. Preset `{"reasoning_effort": "low"}`; this model does not allow turning reasoning off |
| Self-hosted LLM (OpenAI-compatible) | Base URL up to `/v1`, e.g. `http://127.0.0.1:8000/v1`, and the model name served by your server. Key is optional |
| DeepL | Endpoint (`https://api-free.deepl.com` for the free plan) and auth key |
| Mock | Offline demo, calls no API (shown after enabling *More settings → Developer options*) |

Useful **extra request body** values (More settings → engine):

- DeepSeek V4.1 Flash: `{"thinking": {"type": "disabled"}}` — translation does not need reasoning. In our tests this cut the latency of one paragraph from 5.1 s to 1.9 s and output tokens from 411 to 68.
- MiniMax M3.1 Flash: `{"reasoning_effort": "low"}` — reasoning cannot be disabled, but low effort cut output tokens from 508 to 146 and latency from 9.1 s to 4.5 s in our test.
- Qwen3 on vLLM / SGLang: `{"chat_template_kwargs": {"enable_thinking": false}}`

If your model runs on a remote GPU box, just make its address reachable from the browser, e.g. `ssh -L 8000:localhost:8000 gpu-host` and use `http://127.0.0.1:8000/v1`.

## Usage

| Action | |
|---|---|
| Toolbar icon | Open the popup: start/stop, engine, key, language |
| `Alt+Shift+Y` (`⌥⇧Y` on macOS) | Start / stop Duet-Translator on the current tab (change it at `edge://extensions/shortcuts`) |
| Right-click → *Duet-Translator: read side by side from here* | Start at the paragraph you clicked |
| Top bar | Target language, engine, sync on/off, hover highlight, **Whole page**, swap sides, settings, close |
| Divider | Drag to resize the panes |
| Close | The original page returns to the paragraph you were reading |

## Controlling cost

- Only the visible area plus 0.5 screen below is translated (*More settings → screens to pre-translate*; `0` = visible area only).
- No requests while scrolling. Translation starts about 0.3 s after you stop, so content you fly past is never sent.
- In-flight requests for paragraphs you have scrolled far away from are cancelled, so the server stops generating.
- Hidden menus, text already in the target language, and cached paragraphs are never sent. A paragraph that appears several times (forum "reply / share" links, repeated menus) is sent once, and a paragraph already being translated by another request is waited for, not sent again.
- Cached translations are looked up before anything else, for several screens around you and even while you scroll, so pages you have read come back instantly and for free.
- The system prompt is fixed and comes first, so providers with automatic prefix caching (DeepSeek: about 1/50 of the input price on V4 Flash) bill it at the cached rate.
- Every request carries a generous `max_tokens` cap, so a model stuck in a loop cannot run up the bill. Servers that reject `max_tokens` / `stream_options` are detected and retried without them (remembered for the browser session).
- For small self-hosted models, set the engine's *context window*: batches that would not fit (prompt + text + expected translation) are split before sending, and `max_tokens` stays within the remaining room.
- **Whole page** asks for confirmation first and tells you how many characters it will send.
- The top bar shows characters sent and a green meter with this page's tokens (input / cached / output on hover), local cache hits and estimated cost (prices are editable per engine). Settings → *Usage* keeps per-engine totals.

**Cache housekeeping.** The local cache is least-recently-read first, with a second chance for frequently reused entries (menus, navigation), a size limit (default 64 MB) and an expiry for entries unread for 90 days; changing the model or custom prompt switches to a fresh namespace automatically. ↻ in the top bar re-translates the current page (drops only its cached entries); Settings → *Cache* shows hit rate and characters saved, and can clear the current engine only or everything.

On the Wikipedia article above, four stops one screen apart sent about 12,000 characters in total, against about 46,600 for the whole visible article. With DeepSeek (reasoning off) the current screen was fully translated 2–5.5 s after each stop.

A reproducible cost/latency benchmark (simulated DeepSeek-style billing with prefix caching) lives in `test/bench/`. Against the previous version: first paragraph on screen 2.5 s → 1.0 s, revisiting a page 1.6 s → 0.15 s (all from the local cache, zero requests), screen filled after a fast skim 7.8 s → 4.2 s, 14% fewer segments sent on a forum thread, total cost −2.7%. Details and the iteration log are in [docs/DESIGN.md §7.1](docs/DESIGN.md).

## Privacy

- API keys are stored only in this browser (`chrome.storage.local`, not synced) and are used only by the extension's background worker, never exposed to web pages.
- Page text is sent only to the engine you configure.
- To split pages that forbid being embedded, Duet-Translator temporarily removes `X-Frame-Options` / CSP response headers **for the frames of that one tab** while it is open. You can turn this off in settings (such sites then cannot be split).

## How it works

The current tab is covered by a full-screen layer that holds two same-origin iframes of the same URL, so cookies and `X-Frame-Options: SAMEORIGIN` just work. Both panes split the page into paragraphs with the same algorithm and key each paragraph by a hash of its source text, which gives matching anchors on both sides. The longest increasing subsequence of those anchor pairs yields a monotonic, piecewise-linear mapping between the two scroll positions, and a "sliding focus line" makes both sides align at the paragraph being read while still reaching the top and bottom together.

The full design (architecture, sync algorithm, translation pipeline, scheduling) is in [docs/DESIGN.md](docs/DESIGN.md) (in Chinese).

## Development

No build step: the extension is plain JavaScript (Manifest V3).

```bash
cd test
npm install
npx playwright install chromium   # add --with-deps on a fresh Linux box
npm run test:unit                 # scroll-sync math (node:test)
npm run test:options              # settings page and popup
npm run test:e2e                  # loads the extension in Chromium and checks alignment, translation, cost control
npm run test:cache                # cache eviction, dedup, usage accounting, parameter fallback
npm run test:preview              # long paragraphs fill in while generating; cancelled ones revert to the original
node bench/bench.mjs              # cost / latency benchmark against a simulated LLM (see test/bench/README.md)
npm run demo                      # local demo page at http://127.0.0.1:8787/article.html
node e2e/compat.mjs               # real-site compatibility sweep with the offline Mock engine (see docs/COMPAT.md)
```

Live smoke test against a real engine (the key is read from the environment only):

```bash
LIVE_BASE_URL=https://api.deepseek.com LIVE_MODEL=deepseek-flash LIVE_API_KEY=sk-... \
LIVE_EXTRA='{"thinking":{"type":"disabled"}}' LIVE_URL=https://en.wikipedia.org/wiki/Typography \
node e2e/live.mjs
```

Adding an engine: implement `translate(segments, cfg, ctx) → Promise<string[]>` in `extension/background/providers.js` and declare its form fields in `extension/options/options.js`.

## Known limitations

- Each page is loaded twice (once per pane); ads or randomized content may differ between the two sides.
- Text inside Shadow DOM (web components) is not translated.
- Browser pages (`edge://`), the extension stores and the built-in PDF viewer cannot be split.
- Sites that show a cookie-consent dialog need it accepted in each pane (the panes are separate page loads). Sites behind bot protection (e.g. Cloudflare challenges) may refuse to load inside the panes. See [docs/COMPAT.md](docs/COMPAT.md).

## License

[MIT](LICENSE) © 2026 SuperFCR
