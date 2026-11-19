#!/usr/bin/env bash
# Render every deliverable into out/:
#   duet-translator-promo-16x9.mp4   1920x1080, for X/Twitter
#   duet-translator-promo-1x1.mp4    1080x1080 square cut
#   duet-translator-promo.gif        16:9 cut, <= 15 MB (960 px / 15 fps, smaller if needed)
#   stills/*.png                     review frames
#   timeline.json                    computed beat starts and lengths
# Usage: scripts/build.sh [draft|looks|delivery]   (default: looks)
# Extra render flags via HF_RENDER_FLAGS (default "--video-frame-format png": lossless frames from the UI footage).
set -euo pipefail
promo="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
quality="${1:-looks}"
hf="$promo/scripts/hf.sh"
out="$promo/out"
ff="${FFMPEG:-ffmpeg}"
mkdir -p "$out/stills"

# Timing from storyboard.mjs + ffprobe. square.html exists only during the build
# (two root files in the project make `lint` complain).
node "$promo/scripts/timeline.mjs" --square
trap 'rm -f "$promo/square.html" "$out"/.raw-*.mp4' EXIT

read -r -a extra <<< "${HF_RENDER_FLAGS---video-frame-format png}"
"$hf" render --quality "$quality" "${extra[@]}" -o "$out/.raw-16x9.mp4"
"$hf" render -c square.html --quality "$quality" "${extra[@]}" -o "$out/.raw-1x1.mp4"

# Move the moov atom to the front so the upload can start playing before it is fully loaded.
for cut in 16x9 1x1; do
  "$ff" -v error -y -i "$out/.raw-$cut.mp4" -c copy -movflags +faststart "$out/duet-translator-promo-$cut.mp4"
done

# GIF: one palette for the whole clip; step down until it fits in 15 MB.
rm -f "$out"/duet-translator-promo*.gif
gif="$out/duet-translator-promo.gif"
for spec in "960 15 160" "800 15 128" "800 12 128" "720 12 96" "640 10 96"; do
  read -r width fps colors <<< "$spec"
  "$ff" -v error -y -i "$out/duet-translator-promo-16x9.mp4" -vf \
    "fps=$fps,scale=$width:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=$colors:stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=5:diff_mode=rectangle" \
    -loop 0 "$gif"
  size=$(stat -c %s "$gif")
  echo "GIF ${width}px ${fps}fps ${colors} colours: $((size / 1024 / 1024)) MB"
  [ "$size" -le $((15 * 1024 * 1024)) ] && break
done

# Review stills, timed from the computed timeline: "<beat> <seconds into the beat> <name>".
rm -f "$out"/stills/*.png
at() { node -e 'const t=require(process.argv[1]);const b=t.beats.find(x=>x.beat===process.argv[2]);console.log((b.start+Number(process.argv[3])).toFixed(3))' "$out/timeline.json" "$1" "$2"; }
still() { "$ff" -v error -y -ss "$(at "$2" "$3")" -i "$out/duet-translator-promo-$1.mp4" -frames:v 1 "$out/stills/$1-$4.png"; }
still 16x9 open 3.2 01-open
still 16x9 sync 2.5 02-sync
still 16x9 meter 2.6 03-meter
still 16x9 cost 1.8 04-cost
still 1x1 sync 2.5 sq-sync

ls -la "$out"/*.mp4 "$out"/*.gif "$out/stills"
