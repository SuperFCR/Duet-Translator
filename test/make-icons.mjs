// 从 extension/icons/logo.svg（及 16px 简化版 logo-small.svg）渲染扩展图标 PNG；--preview 额外输出预览图
import { chromium } from 'playwright';
import { readFileSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const ICONS = resolve(here, '../extension/icons');
const big = readFileSync(join(ICONS, 'logo.svg'), 'utf8');
const small = readFileSync(join(ICONS, 'logo-small.svg'), 'utf8');
const browser = await chromium.launch({ channel: 'chromium', headless: true });
const page = await browser.newPage({ deviceScaleFactor: 1 });
const svgUrl = (s) => 'data:image/svg+xml;base64,' + Buffer.from(s).toString('base64');

for (const size of [16, 32, 48, 128]) {
  const src = size <= 32 ? small : big;   // 32px 及以下用简化版，文字线太细会糊
  await page.setViewportSize({ width: size, height: size });
  await page.setContent(`<style>html,body{margin:0;background:transparent}</style><img src="${svgUrl(src)}" width="${size}" height="${size}" style="display:block">`);
  await page.locator('img').evaluate((img) => img.decode());
  await page.screenshot({ path: join(ICONS, `icon-${size}.png`), omitBackground: true, clip: { x: 0, y: 0, width: size, height: size } });
  console.log('icon', size);
}

if (process.argv.includes('--preview')) {
  mkdirSync(join(here, 'e2e/out'), { recursive: true });
  const cell = (bg, size, file) => `<div style="background:${bg};padding:14px;display:flex;align-items:center;justify-content:center;width:150px;height:150px">
    <img src="${file}" style="width:${size}px;height:${size}px;image-rendering:auto"></div>`;
  const png = (s) => 'data:image/png;base64,' + readFileSync(join(ICONS, `icon-${s}.png`)).toString('base64');
  const rows = ['#ffffff', '#f1f5f9', '#202124', '#0f172a'].map((bg) =>
    `<div style="display:flex">${cell(bg, 128, png(128))}${cell(bg, 48, png(48))}${cell(bg, 32, png(32))}${cell(bg, 16, png(16))}${cell(bg, 64, png(16))}</div>`).join('');
  await page.setViewportSize({ width: 5 * 178, height: 4 * 178 });
  await page.setContent(`<body style="margin:0">${rows}</body>`);
  await page.waitForTimeout(200);
  await page.screenshot({ path: join(here, 'e2e/out/logo-preview.png') });
  console.log('preview → e2e/out/logo-preview.png（最后一列是 16px 图标放大 4 倍）');
}
if (process.argv.includes('--social')) {
  // GitHub 仓库 Settings → Social preview 用（1280×640）
  await page.setViewportSize({ width: 1280, height: 640 });
  await page.setContent(`<body style="margin:0;width:1280px;height:640px;display:flex;align-items:center;justify-content:center;gap:64px;
      background:linear-gradient(135deg,#f8fafc,#e0ecff);font-family:system-ui,'Segoe UI',sans-serif">
    <img src="${svgUrl(big)}" width="260" height="260">
    <div>
      <div style="font-size:88px;font-weight:800;color:#0f172a;letter-spacing:-1px">Duet-Translator</div>
      <div style="font-size:36px;color:#334155;margin-top:14px">Read the web side by side · 对读</div>
      <div style="font-size:26px;color:#64748b;margin-top:22px">Paragraph-aligned sync scrolling · Bring your own LLM</div>
    </div></body>`);
  await page.waitForTimeout(300);
  await page.screenshot({ path: resolve(here, '../docs/images/social-preview.png') });
  console.log('social → docs/images/social-preview.png');
}
await browser.close();
