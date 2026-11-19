#!/usr/bin/env node
// Build step: storyboard.mjs + real clip lengths (ffprobe) -> index.html (1920x1080).
//   node scripts/timeline.mjs            writes index.html and out/timeline.json
//   node scripts/timeline.mjs --square   also writes square.html (1080x1080; build.sh deletes it after rendering)
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const promo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sb = (await import(pathToFileURL(path.join(promo, "storyboard.mjs")).href)).default;
const ffprobe = process.env.FFPROBE || "ffprobe";
const round = (n) => Math.round(n * 1000) / 1000;
const frameFloor = (n) => Math.floor(n * sb.fps + 1e-6) / sb.fps; // cuts on frame boundaries, never past a clip end
const isVideo = (src) => /\.(mp4|mov|webm|m4v)$/i.test(src);
const attr = (s) => String(s).replace(/&/g, "&amp;").replace(/'/g, "&#39;").replace(/"/g, "&quot;");

function probe(file) {
  const out = execFileSync(ffprobe, ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", file]);
  const d = parseFloat(String(out).trim());
  if (!Number.isFinite(d)) throw new Error(`ffprobe: no duration for ${file}`);
  return d;
}

// ---- timing ----
const warnings = [];
let t = 0;
const beats = sb.beats.map((b) => {
  const beat = { ...b, start: round(t) };
  if (b.scene) {
    beat.kind = "scene";
    beat.dur = b.dur;
  } else {
    beat.kind = "footage";
    let src = b.src;
    if (!fs.existsSync(path.join(promo, src))) {
      // Stand-in: the clip's own poster (same name, .png), else the first fallback that exists.
      const candidates = [src.replace(/\.[^.]+$/, ".png"), ...[].concat(sb.fallback)];
      const found = candidates.find((c) => c !== src && fs.existsSync(path.join(promo, c)));
      if (!found) throw new Error(`missing ${src} and no fallback (${candidates.join(", ")})`);
      warnings.push(`missing ${src}: showing ${found} for ${b.max ?? b.dur ?? 3}s`);
      src = found;
    }
    beat.file = src;
    delete beat.in;
    delete beat.rate;
    if (isVideo(src)) {
      const rate = b.rate || 1;
      const avail = (probe(path.join(promo, src)) - (b.in || 0)) / rate;
      beat.sourceLen = round(probe(path.join(promo, src)));
      beat.dur = frameFloor(Math.min(avail, b.max ?? avail));
      beat.rate = rate;
      beat.in = b.in || 0;
    } else {
      beat.dur = b.dur ?? b.max ?? 3;
    }
  }
  t += beat.dur;
  return beat;
});
const total = round(t);
if (total > sb.maxTotal) warnings.push(`total ${total}s is over maxTotal ${sb.maxTotal}s: lower some max / raise rate`);

// Group consecutive footage beats: one window per group.
const groups = [];
for (const b of beats) {
  if (b.kind !== "footage") continue;
  const last = groups[groups.length - 1];
  if (last && last.end === b.start) last.end = round(b.start + b.dur);
  else groups.push({ start: b.start, end: round(b.start + b.dur) });
}

// ---- HTML ----
function render(fmt) {
  const W = fmt === "square" ? 1080 : 1920;
  const H = 1080;
  const rootId = fmt === "square" ? "main-square" : "main";
  // Browser window that holds the footage: [left, top, width] and the fake title-bar height.
  const win = fmt === "square" ? { x: 40, y: 330, w: 1000, bar: 26 } : { x: 260, y: 200, w: 1400, bar: 30 };
  const viewH = Math.round((win.w * sb.source.height) / sb.source.width);
  const k = win.w / sb.source.width; // source px -> window px

  const cams = [];
  const hosts = [];
  const zooms = [];
  let z = 3;
  for (const b of beats) {
    if (b.kind === "scene") {
      hosts.push(
        `      <div id="${b.scene}" data-composition-id="${b.scene}" data-composition-src="compositions/${b.scene}.html"\n` +
          `        data-start="${b.start}" data-duration="${b.dur}" data-track-index="1" data-track-kind="graphics"\n` +
          `        data-width="${W}" data-height="${H}" style="z-index: ${z++}"></div>`,
      );
      continue;
    }
    const timing = `data-start="${b.start}" data-duration="${b.dur}"`;
    const media = isVideo(b.file)
      ? `<video id="clip-${b.id}" class="clip fw-media" ${timing}${b.in ? ` data-media-start="${b.in}"` : ""}` +
        `${b.rate !== 1 ? ` data-playback-rate="${b.rate}"` : ""} data-track-index="0"\n            src="${b.file}" muted playsinline></video>`
      : `<img id="clip-${b.id}" class="clip fw-media" ${timing} data-track-index="0" src="${b.file}" alt="" />`;
    const overlay = b.overlay
      ? `\n          <img id="clip-${b.id}-overlay" class="clip fw-overlay" ${timing} data-track-index="2" src="${b.overlay.src}" alt=""` +
        ` style="height: ${round(b.overlay.height * k)}px" />`
      : "";
    const origin = b.zoom ? ` style="transform-origin: ${round(b.zoom.x * k)}px ${round(b.zoom.y * k)}px"` : "";
    cams.push(`        <div class="fw-cam" id="cam-${b.id}"${origin}>\n          ${media}${overlay}\n        </div>`);
    if (b.zoom?.dimBelow) {
      const top = round(b.zoom.dimBelow * k * b.zoom.to);
      cams.push(`        <div class="clip fw-dim" id="dim-${b.id}" ${timing} data-track-index="3" style="top: ${top}px"></div>`);
    }
    if (b.zoom) {
      const zt = round(b.start + (b.zoom.at ?? 0.3));
      zooms.push(
        `      tl.fromTo("#cam-${b.id}", { scale: 1 }, { scale: ${b.zoom.to}, duration: ${b.zoom.dur ?? 0.6}, ease: "power3.inOut", immediateRender: false }, ${zt});`,
      );
      if (b.zoom.dimBelow)
        zooms.push(
          `      tl.fromTo("#dim-${b.id}", { opacity: 0 }, { opacity: 1, duration: 0.35, ease: "power2.out", immediateRender: false }, ${round(zt + (b.zoom.dur ?? 0.6) - 0.1)});`,
        );
    }
    if (b.caption) {
      const values = JSON.stringify({ title: b.caption.title, sub: b.caption.sub || "", dur: b.dur });
      hosts.push(
        `      <div id="cap-${b.id}" data-composition-id="cap-${b.id}" data-composition-src="compositions/caption.html"\n` +
          `        data-start="${b.start}" data-duration="${b.dur}" data-track-index="1" data-track-kind="graphics"\n` +
          `        data-width="${W}" data-height="${H}" style="z-index: ${z++}"\n` +
          `        data-variable-values='${attr(values)}'></div>`,
      );
    }
  }

  const rig = groups
    .map(
      (g, i) =>
        `      tl.fromTo("#fw-rig", { y: 140, scale: 0.94, opacity: 0, filter: "blur(10px)" }, { y: 0, scale: 1, opacity: 1, filter: "blur(0px)", duration: 0.6, ease: "expo.out", immediateRender: false }, ${g.start});\n` +
        `      tl.to("#fw-rig", { y: -30, scale: 0.96, opacity: 0, filter: "blur(8px)", duration: 0.28, ease: "power3.in" }, ${round(g.end - 0.3)});`,
    )
    .join("\n");

  return `<!doctype html>
<!--
  GENERATED by scripts/timeline.mjs from storyboard.mjs (${fmt === "square" ? "1080x1080 square cut" : "1920x1080"}, ${total} s).
  Do not edit by hand: change storyboard.mjs or a scene in compositions/, then run node scripts/timeline.mjs.
-->
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=${W}, height=${H}" />
    <script src="https://cdn.jsdelivr.net/npm/gsap@3.15.0/dist/gsap.min.js"></script>
    <link rel="stylesheet" href="assets/theme.css" />
    <style>
      html,
      body {
        width: ${W}px;
        height: ${H}px;
      }
      #fw-rig {
        position: absolute;
        opacity: 0;
        left: ${win.x}px;
        top: ${win.y}px;
        width: ${win.w}px;
        z-index: 2;
      }
      #fw-window {
        border-radius: 18px;
        overflow: hidden;
        background: var(--paper);
        box-shadow: 0 40px 90px rgba(30, 64, 175, 0.18), 0 0 0 1px rgba(15, 23, 42, 0.08);
      }
      #fw-bar {
        height: ${win.bar}px;
        display: flex;
        align-items: center;
        gap: 8px;
        padding: 0 16px;
        background: #eef2f8;
        border-bottom: 1px solid #dde3ec;
      }
      .fw-dot {
        width: 11px;
        height: 11px;
        border-radius: 50%;
        background: #cbd5e1;
      }
      #fw-view {
        position: relative;
        height: ${viewH}px;
        overflow: hidden;
      }
      .fw-cam {
        position: absolute;
        inset: 0;
      }
      .fw-media {
        position: absolute;
        left: 0;
        top: 0;
        width: 100%;
        height: 100%;
        object-fit: cover;
      }
      .fw-dim {
        position: absolute;
        left: 0;
        right: 0;
        bottom: 0;
        opacity: 0;
        background: linear-gradient(rgba(248, 250, 252, 0.55), rgba(248, 250, 252, 0.94) 140px);
      }
      .fw-overlay {
        position: absolute;
        left: 0;
        top: 0;
        width: 100%;
      }
    </style>
  </head>
  <body>
    <div id="root" data-composition-id="${rootId}" data-start="0" data-duration="${total}"
      data-width="${W}" data-height="${H}" data-fps="${sb.fps}">
      <div id="ground"></div>

      <!-- Footage window: each clip shows only during its own data-start/data-duration. -->
      <div id="fw-rig">
        <div id="fw-window">
          <div id="fw-bar"><span class="fw-dot"></span><span class="fw-dot"></span><span class="fw-dot"></span></div>
          <div id="fw-view">
${cams.join("\n")}
          </div>
        </div>
      </div>

      <!-- Scenes and captions. -->
${hosts.join("\n")}
    </div>
    <script>
      const tl = gsap.timeline({ paused: true });
${rig}
${zooms.join("\n")}
      window.__timelines["${rootId}"] = tl;
    </script>
  </body>
</html>
`;
}

fs.writeFileSync(path.join(promo, "index.html"), render("wide"));
if (process.argv.includes("--square")) fs.writeFileSync(path.join(promo, "square.html"), render("square"));
fs.mkdirSync(path.join(promo, "out"), { recursive: true });
const summary = beats.map((b) => ({
  beat: b.scene || b.id,
  start: b.start,
  dur: b.dur,
  ...(b.kind === "footage" ? { file: b.file, in: b.in, rate: b.rate, sourceLen: b.sourceLen } : {}),
}));
fs.writeFileSync(path.join(promo, "out", "timeline.json"), JSON.stringify({ total, beats: summary }, null, 2) + "\n");

for (const b of summary) {
  const extra = b.file ? `  ${b.file}${b.in ? ` from ${b.in}s` : ""}${b.rate && b.rate !== 1 ? ` at ${b.rate}x` : ""}` : "";
  console.log(`${String(b.start.toFixed(2)).padStart(6)}s  ${String(b.dur.toFixed(2)).padStart(5)}s  ${b.beat.padEnd(8)}${extra}`);
}
console.log(`total ${total}s`);
for (const w of warnings) console.warn(`warning: ${w}`);
