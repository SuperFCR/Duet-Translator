// Duet-Translator promo storyboard: the one place to change order, trims and copy.
// After editing, run `node scripts/timeline.mjs` (scripts/build.sh does it for you): it reads each
// clip's real length with ffprobe, computes every start time and writes index.html (+ square.html).
//
// Beat kinds
//   { scene, dur }   a hand-built scene in compositions/<scene>.html, fixed length in seconds.
//   { id, src, ... } footage shown in the browser window:
//      src       assets/… .mp4 or image. A missing file is replaced (with a warning) by its poster
//                (same name, .png), else by the first `fallback` image that exists.
//      in        seconds to skip at the start of the clip (default 0)
//      rate      playback speed (default 1)
//      max       longest on-screen time in seconds; the clip is cut there (default: to its end)
//      dur       on-screen time for an image
//      overlay   { src, height }: an image laid over the top edge of the footage (source px)
//      zoom      { to, x, y, at, dur, dimBelow }: push in to scale `to` around source pixel (x, y),
//                starting `at` seconds into the beat; dimBelow (source px) fades the picture below that line
//      caption   { title, sub }: shown above the window; wrap words in *asterisks* for the accent
// Consecutive footage beats share one window; it rises on the first and leaves on the last.

export default {
  fps: 30,
  maxTotal: 35,
  source: { width: 1920, height: 1080 },
  fallback: ["assets/hero.png", "assets/01-open.png"],
  beats: [
    { scene: "hook", dur: 3.2 },
    {
      id: "open",
      src: "assets/01-open.mp4", // split opens at 2.1 s, translation streams in until ~5.4 s
      in: 1.3,
      rate: 1.15,
      max: 3.6,
      caption: { title: "Translates only *what you read*", sub: "The screen you're on, plus a little ahead." },
    },
    {
      id: "sync",
      src: "assets/02-sync-scroll.mp4",
      in: 0.3,
      rate: 1.8,
      max: 5.0,
      caption: { title: "Paragraph-aligned *sync scrolling*", sub: "Scroll either side; the other follows." },
    },
    {
      id: "hover",
      src: "assets/03-hover.mp4",
      in: 0.3,
      rate: 1.6,
      max: 3.6,
      caption: { title: "Hover to *compare*", sub: "The same paragraph lights up on both sides." },
    },
    {
      id: "cache",
      src: "assets/04-cache.mp4", // closes at 0.95 s, reopens at 2.26 s, filled from cache 0.36 s later
      in: 0.5,
      max: 3.6,
      caption: { title: "Revisits are *instant*", sub: "Straight from local cache. Duplicates sent once." },
    },
    {
      id: "meter",
      src: "assets/hero.png",
      dur: 3.0,
      overlay: { src: "assets/05-meter-bar.png", height: 39 },
      // Push in on the meter ("2,472 chars sent" … "3.2k tokens | 17 from cache | <$0.001") and fade the page below it.
      zoom: { to: 2.6, x: 600, y: 0, at: 0.35, dur: 0.6, dimBelow: 39 },
      caption: { title: "Live token & *cost meter*", sub: "Prompt-cache aware: DeepSeek, OpenAI…" },
    },
    { scene: "engines", dur: 3.6 },
    { scene: "cost", dur: 3.0 },
    { scene: "outro", dur: 3.6 },
  ],
};
