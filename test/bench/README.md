# Cost / speed bench

Measures what on-demand translation costs (tokens, USD) and how long the reader waits. It loads the extension in Playwright and points the `deepseek` preset at a simulated, OpenAI-compatible LLM (`llm-sim.mjs`), so no API key is needed.

```bash
cd test
# On this WSL box bench.mjs adds ~/.cache/st-e2e-libs to LD_LIBRARY_PATH / FONTCONFIG_FILE itself if they are unset.

# Baseline (git HEAD) vs. working tree
git -C .. worktree add --detach /tmp/duet-base HEAD      # once
EXT_DIR=/tmp/duet-base/extension BENCH_LABEL=baseline node bench/bench.mjs
BENCH_LABEL=current node bench/bench.mjs                 # default EXT_DIR = ../extension
node bench/compare.mjs baseline current                  # labels or paths to out/*.json

# Parameter sweeps
BENCH_LABEL=bc800  BENCH_OVERRIDES='{"batchChars":800}'   node bench/bench.mjs
BENCH_LABEL=pf1    BENCH_SETTINGS='{"prefetchScreens":1}' node bench/bench.mjs
node bench/compare.mjs current bc800 pf1
```

One full run takes about 2.3 minutes. It prints a markdown table and writes `out/<label>.json`, which includes a per-request log for each scenario.

## Environment variables

| var | meaning |
|---|---|
| `EXT_DIR` | Extension folder to load. Relative paths resolve against the current directory. Default: the repo's `extension/`. |
| `BENCH_LABEL` | Name of the result file `out/<label>.json`. |
| `BENCH_OVERRIDES` | JSON merged into the `deepseek` provider, e.g. `{"batchChars":800,"concurrency":6}`. Otherwise the version's own preset values are used. `baseUrl` and `apiKey` are always set to the sim. |
| `BENCH_SETTINGS` | JSON merged into the global settings, e.g. `{"prefetchScreens":1}`. |
| `BENCH_SCENARIOS` | Comma list. Default: `read,revisit,skim,forum`. |
| `BENCH_READ_STEPS` / `BENCH_DWELL_MS` / `BENCH_CAP_MS` | Scroll steps for read and forum (12), dwell per step (3500 ms), wait cap (15000 ms). |
| `BENCH_HEADED=1` | Run with a visible browser window (needs a display). |
| `SIM_*` | Sim parameters (see below). |

## Scenarios

The article is `demo/article.html` (78 blocks). Each scenario opens a fresh tab. The sim log is reset between scenarios. The sim's prefix cache is **not** reset: it lasts for the whole run, like DeepSeek's.

- **read**: Cold extension (fresh browser profile, empty translation cache). Opens the article in split view. After 3.5 s, scrolls the left pane by 0.4 screen every 3.5 s, 12 times.
- **revisit**: Same profile as `read`, so its cache is warm. Closes the split and the tab, opens the article in a new tab, reopens the split, then repeats the first 4 read steps. If `read` didn't run, an unmeasured read runs first.
- **skim**: Cold profile. Opens the split, flicks to the bottom 1.5 s later (600 px wheels, 60 ms apart), stops for 4 s, flicks back to the top, stops for 4 s.
- **forum**: Cold profile. Runs the `read` pattern on `pages/forum.html`, an HN/Reddit-like thread with 150 nested comments. Each comment has a username + points line, an age link ("3 hours ago"), and `reply`/`share`/`report`/`permalink` items, each its own block. This scenario measures duplicate-segment handling. Regenerate the page with `node bench/gen-forum.mjs`.

## Metrics

- **req / abort**: Requests the sim received, and how many the client aborted mid-generation.
- **segs (dup)**: Segments sent, summed over requests. *dup* counts segments whose text was already sent earlier in the same scenario, either in the same request or an earlier one.
- **in miss / in hit / out (aborted)**: Billed tokens. Output includes tokens generated before an abort.
- **cost**: `miss×priceMiss + hit×priceHit + out×priceOut`.
- **first tr ms**: Time from toggling the split until the first block in the right pane contains CJK. Blocks that were Chinese in the original are ignored. **1st screen ms**: time until every visible block is translated.
- **wait mean / p90**: Measured after each scroll stop. It starts when the right pane stops moving and ends when every *visible text block* is translated. A visible text block is a `p, li, h1-h6, td, dd, blockquote, dt, figcaption` element that intersects the right viewport and has ≥ 15 letters in the original. Translated means it contains a CJK character. Waits are capped at 15 s. The reader never scrolls before the screen is translated (up to the cap), so the next step happens at max(dwell, wait).

## Simulated LLM (`llm-sim.mjs`)

Run it standalone with `PORT=8790 node bench/llm-sim.mjs`. Its endpoints are `POST …/chat/completions` (SSE or JSON), `GET /__log`, `GET /__stats`, `POST /__reset[?cache=1]`, and `GET|POST /__config`.

- **Translation**: Output is fake Chinese at about 0.55 × the source characters. It is deterministic for a given source and keeps `<gN>…</gN>` / `<xN/>` tags. A JSON array in the last user message gets a same-length plain JSON array back, without code fences. Text before the array is tolerated, and a `{id: text}` object also works. Anything else is treated as single text.
- **Tokens**: CJK characters count 0.6 tokens each and everything else 0.3, summed over all message contents.
- **Prefix cache**: The cached input of a request is the longest common prefix of its serialized messages (`role\ncontent\n…`) with any earlier request that finished prefill. That means it completed, or it was aborted after the first token. The prefix is converted to tokens and floored to a multiple of 64. Requests that run at the same time can't hit each other's cache.
- **Latency**: Time to first token is `600 ms + 0.05 ms × uncached input tokens`. After that, output streams at 45 tokens/s in chunks of about 2 tokens. A non-streaming response is sent when generation finishes. A client abort stops generation; tokens generated so far are billed, and all input is billed.
- **Request parameters**: `max_tokens` (or `max_completion_tokens`) truncates the output and sets `finish_reason: "length"`. Without it the cap is 8192. `stream_options` is accepted. `usage` (`prompt_cache_hit/miss_tokens`, `prompt_tokens_details.cached_tokens`) is always returned: in the JSON response, or, when streaming, in the final chunk (the one that carries `finish_reason`, DeepSeek style) before `[DONE]`.
- **Environment variables**: `SIM_TTFT_MS`, `SIM_TTFT_PER_TOKEN_MS`, `SIM_TPS`, `SIM_CHUNK_TOKENS`, `SIM_RATIO`, `SIM_PRICE_MISS` (0.14), `SIM_PRICE_HIT` (0.0028), `SIM_PRICE_OUT` (0.28) in USD/1M, `SIM_DEFAULT_MAX_TOKENS`, `SIM_REJECT_STREAM_OPTIONS=1` (requests carrying `stream_options` get HTTP 400), and `SIM_LOG_TEXT=1` (logs the first 80 characters of each segment).
- **Per-request overrides**: Pass latency settings in the query (`?ttft=800&tps=30`) or as a path prefix that can go straight into a baseUrl: `http://127.0.0.1:PORT/cfg/ttft=800,tps=30/v1`.

## Caveats

- Timing comes from a real headless Chromium, so expect run-to-run noise of a few hundred ms on waits. Token and cost numbers are nearly deterministic. Compare runs made on the same machine, and repeat a run when differences are small.
- A cold scenario uses a fresh browser profile, which clears every extension cache layer (IndexedDB and anything held in the service worker).
- Wait time only covers the listed block tags. Text in `div`/`span` runs, such as forum metadata and the article's HN-style comment run, is translated but doesn't count toward waits.
