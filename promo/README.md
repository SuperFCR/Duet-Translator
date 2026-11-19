# Duet-Translator promo video

A ~32 s silent promo for X/Twitter, built with [HyperFrames](https://github.com/heygen-com/hyperframes)
(HeyGen, Apache-2.0, pinned to `hyperframes@0.9.70`). The scenes are HTML + CSS with paused GSAP
timelines; the CLI seeks them frame by frame in headless Chrome and encodes the frames with FFmpeg.

## Render

```bash
cd promo
npm install            # once
scripts/build.sh       # or: scripts/build.sh draft   (faster, lower quality)
```

| Output | What |
|---|---|
| `out/duet-translator-promo-16x9.mp4` | 1920×1080, 30 fps, H.264, no audio track. The X upload |
| `out/duet-translator-promo-1x1.mp4` | 1080×1080 square cut, same beats |
| `out/duet-translator-promo.gif` | 16:9 cut, ≤ 15 MB: 960 px / 15 fps, stepping down to 800/720/640 px if needed |
| `out/stills/*.png` | Review frames |
| `out/timeline.json` | Computed start and length of every beat |

A build takes under a minute. It first runs `node scripts/timeline.mjs`, which reads each clip's length with
`ffprobe` and writes `index.html` (and, during the build only, `square.html`). Re-run the build whenever a clip in
`assets/` changes.

Other commands (run `node scripts/timeline.mjs` first if the storyboard or footage changed; the `npm run` versions do):
`scripts/hf.sh lint`, `scripts/hf.sh check`, `scripts/hf.sh snapshot --at 5,12` (PNG frames under
`.hyperframes/artifacts/snapshots/`), `scripts/hf.sh preview` (Studio editor; prints its URL, stop with
`scripts/hf.sh preview --stop`).

`scripts/hf.sh` runs the local CLI with telemetry off (`HYPERFRAMES_NO_TELEMETRY=1`). On this WSL box it uses
Playwright's `chrome-headless-shell` plus the user-space libraries and fonts in `~/.cache/st-e2e-libs`. On any other
machine it falls back to HyperFrames' own Chrome: run `scripts/hf.sh browser ensure` once (needs `unzip`). FFmpeg
and ffprobe must be on `PATH`.

## Editing

**Order, trims, speed and caption copy: `storyboard.mjs`.** The header comment lists every field. Footage beats
take `in` (seconds skipped), `rate` (speed), `max` (longest on-screen time); their length is then whatever the clip
gives, so a re-recorded clip of a different length just shifts everything after it. `maxTotal` (35 s) only warns.
A missing clip is replaced by its poster PNG, with a warning, so the film always renders.

**The cost number:** `compositions/cost.html`, top of the file, `data-composition-variables`: `saving` (`"75"`, shown
as `~75%`, counts up), `savingUnit` (`less text sent`), `savingNote` (`than translating the whole page`). Basis:
DeepSeek on Wikipedia "Typography", reading 4 screens sent ~11.6k characters against ~46.6k for the whole page.

**Look of a beat:** `compositions/<scene>.html` (hook, engines, cost, outro, and `caption.html` for the line above
the footage window). The window itself (position, size, title bar) is in `scripts/timeline.mjs`, function `render`.

| Time (s) | Beat | Source | Caption |
|---|---|---|---|
| 0–3.2 | hook | text | "Read any web page in two languages — side by side." |
| 3.2–6.8 | open | `01-open.mp4` from 1.3 s, 1.15× | Translates only *what you read* |
| 6.8–11.8 | sync | `02-sync-scroll.mp4` from 0.3 s, 1.8× | Paragraph-aligned *sync scrolling* |
| 11.8–15.4 | hover | `03-hover.mp4` from 0.3 s, 1.6× | Hover to *compare* |
| 15.4–19.0 | cache | `04-cache.mp4` from 0.5 s | Revisits are *instant* |
| 19.0–22.0 | meter | `hero.png` + `05-meter-bar.png`, push-in | Live token & *cost meter* |
| 22.0–25.6 | engines | text | Bring your own model: DeepSeek, Qwen, Ollama, vLLM, DeepL… |
| 25.6–28.6 | cost | text | ~75% less text sent |
| 28.6–32.2 | outro | logo | Duet-Translator · Open source · github.com/SuperFCR/Duet-Translator |

(Times as of the current clips; `out/timeline.json` has the real ones after a build.)

`compositions/sync.html` (animated two-page diagram) and `compositions/ondemand.html` (page minimap: only the screen
you stop on is translated, revisits come from cache) are not in the storyboard any more; add
`{ scene: "sync", dur: 3.6 }` or `{ scene: "ondemand", dur: 5.6 }` to use them.

## Layout

```
storyboard.mjs        beat order, trims, captions
scripts/timeline.mjs  storyboard + ffprobe -> index.html / square.html (GENERATED, do not edit)
scripts/build.sh      renders everything into out/
scripts/hf.sh         HyperFrames CLI wrapper (browser, libs, telemetry off)
compositions/*.html   one scene per file; each lays out for 16:9 and, via a container query, for 1:1
assets/theme.css      brand colours from extension/icons/logo.svg
assets/               footage (*.mp4 are git-ignored), posters, meter crops, hero.png, logo.svg
```

## Notes

- Write font names literally in scene CSS (`font-family: "Inter", sans-serif`). The compiler embeds bundled fonts
  only when it sees the name; through a CSS variable the render fell back to DejaVu Sans.
- The render prints `Lint: 1 error(s)` while `square.html` exists (`multiple_root_compositions`). It is harmless;
  `scripts/hf.sh lint` on its own reports 0 errors.
- `check` warns `film_silent`: the film is silent on purpose.
- The footage is rendered with `--video-frame-format png` (lossless frame extraction, better for UI text);
  override with `HF_RENDER_FLAGS=""`.
