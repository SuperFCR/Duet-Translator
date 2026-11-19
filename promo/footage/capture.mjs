// Step 1: capture the exact segment strings the extension sends for the demo article (-> segments.json).
import { startServer } from './server.mjs';
import { launch, configure, toggle, panes, waitTranslated, statusText, sleep } from './lib.mjs';
import { writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { here } from './lib.mjs';

rmSync(join(here, 'segments.json'), { force: true });
const srv = await startServer({ capture: true, speed: 20 });
const BASE = `http://127.0.0.1:${srv.port}`;
const { ctx, sw } = await launch();
await configure(sw, BASE);
const page = await ctx.newPage();
page.on('dialog', (d) => d.accept());
await page.goto(`${BASE}/article.html`);
await sleep(500);
await toggle(sw, `${BASE}/article.html`);
await panes(page);
await sleep(1500);
await page.locator('pt-split-root #all').click();
await sleep(500);
console.log(await waitTranslated(page, 60000));
console.log('segments captured:', srv.captured.length, 'requests:', srv.stats.requests);
writeFileSync(join(here, 'segments.json'), JSON.stringify(srv.captured, null, 2));
await ctx.close();
srv.close();
