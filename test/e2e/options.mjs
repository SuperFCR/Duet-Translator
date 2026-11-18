// 设置页冒烟测试：渲染、填 Key、切换当前引擎、保存、"测试"按钮
import { chromium } from 'playwright';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startServer } from './server.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const EXT = resolve(here, '../../extension');
let fail = 0;
const check = (ok, msg, x) => { console.log(`${ok ? '  ✔' : '  ✖'} ${msg}${x !== undefined ? '  ' + JSON.stringify(x) : ''}`); if (!ok) fail++; };
const srv = await startServer(0);
const dir = mkdtempSync(join(tmpdir(), 'st-opt-'));
const ctx = await chromium.launchPersistentContext(dir, { channel: 'chromium', headless: true, args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`] });
let [sw] = ctx.serviceWorkers(); if (!sw) sw = await ctx.waitForEvent('serviceworker');
const id = new URL(sw.url()).host;
const page = await ctx.newPage();
const errs = []; page.on('pageerror', (e) => errs.push(String(e)));
await page.goto(`chrome-extension://${id}/options/options.html`);
await page.waitForSelector('fieldset.prov');
// 界面语言：默认跟随浏览器（headless 为 en-US）→ 英文；切到中文立即生效并保存
check(await page.locator('h2').first().textContent() === 'General', '默认跟随浏览器语言（英文）', await page.locator('h2').first().textContent());
check(await page.locator('#activeProviderId option:checked').textContent() === 'DeepSeek V4.1 Flash', '默认引擎为 DeepSeek');
await page.selectOption('#uiLang', 'zh');
const zhOk = await page.waitForFunction(() => document.querySelector('h2').textContent === '通用' && document.querySelector('#save').textContent === '保存', null, { timeout: 5000 }).then(() => true, () => false);
check(zhOk, '设置页切换为中文', await page.locator('h2').first().textContent());
check((await sw.evaluate(async () => (await chrome.storage.local.get('settings')).settings.uiLang)) === 'zh', '界面语言立即保存');
const legends = await page.locator('fieldset.prov legend').allTextContents();
check(legends.some((l) => l.includes('deepseek')), '设置页列出 DeepSeek 预设', legends);
const ds = page.locator('fieldset.prov', { hasText: 'deepseek' });
check(await ds.locator('input').nth(3).inputValue() === 'deepseek-flash', 'DeepSeek 预设模型为 deepseek-flash');
await ds.locator('input[type=password]').fill('sk-fake-for-test');
// "测试"按钮：把 DeepSeek 预设临时指向本地假服务，验证按钮链路
await ds.locator('input').nth(1).fill(`http://127.0.0.1:${srv.port}/v1`);
await ds.locator('button.test').click();
await page.waitForFunction(() => /成功|失败/.test(document.querySelector('fieldset.prov:nth-of-type(2) pre.out')?.textContent || [...document.querySelectorAll('pre.out')].map((x) => x.textContent).join('')), null, { timeout: 10000 });
const out = (await ds.locator('pre.out').textContent()) || '';
check(out.startsWith('成功'), '「测试」按钮可用', out.slice(0, 80));
await ds.locator('input').nth(1).fill('https://api.deepseek.com');
await page.selectOption('#activeProviderId', 'deepseek');
await page.click('#save');
await page.waitForFunction(() => document.getElementById('saved').textContent.includes('已保存'));
const st = await sw.evaluate(async () => (await chrome.storage.local.get('settings')).settings);
const p = st.providers.find((x) => x.id === 'deepseek');
check(st.activeProviderId === 'deepseek' && p.apiKey === 'sk-fake-for-test' && p.baseUrl === 'https://api.deepseek.com', '保存后：当前引擎=DeepSeek，Key 已存入 storage.local');
await page.reload(); await page.waitForSelector('fieldset.prov');
check(await page.locator('#activeProviderId').inputValue() === 'deepseek', '刷新后设置保持');
check(errs.length === 0, '设置页无 JS 报错', errs);

/* ---------- 工具栏弹窗：填 Key / 切引擎实时生效 / 开关分屏 ---------- */
console.log('\n[popup]');
const BASE = `http://127.0.0.1:${srv.port}`;
await sw.evaluate(async (base) => {
  const s = await globalThis.PT.loadSettings();
  const providers = s.providers.filter((p) => p.id !== 'authfake').concat([{ id: 'authfake', type: 'openai', name: '需要 Key 的假服务', baseUrl: base + '/auth/v1', apiKey: '', model: 'fake-model', temperature: '', extraBody: '', batchChars: 1500, batchSize: 20, concurrency: 3, timeoutMs: 10000 }]);
  await globalThis.PT.saveSettings({ providers, activeProviderId: 'authfake', targetLang: 'zh-CN' });
}, BASE);
const art = await ctx.newPage();
await art.goto(`${BASE}/article.html`);
const tabId = await sw.evaluate(async (u) => (await chrome.tabs.query({})).find((t) => t.url === u).id, art.url());
const pop = await ctx.newPage();
pop.on('pageerror', (e) => errs.push(String(e)));
await pop.goto(`chrome-extension://${id}/popup/popup.html?tab=${tabId}`);
await pop.waitForFunction(() => document.getElementById('toggle').textContent.includes('开启'));
check(await pop.locator('#engine').inputValue() === 'authfake', '弹窗显示当前引擎');
check(await pop.locator('#f-apiKey').count() === 1 && await pop.locator('#f-baseUrl').count() === 1 && await pop.locator('#f-model').count() === 1, '弹窗可直接编辑 API Key / Base URL / 模型');
await pop.click('#toggle');
const status = () => art.evaluate(() => document.querySelector('pt-split-root')?.shadowRoot.getElementById('status').textContent || '');
const waitFor = async (fn, ms = 15000) => { const t = Date.now(); while (Date.now() - t < ms) { if (await fn()) return true; await new Promise((r) => setTimeout(r, 200)); } return false; };
check(await waitFor(async () => /API Key/.test(await status())), '未填 Key：分屏顶栏提示去插件图标填写', await status());
check(await waitFor(async () => (await pop.locator('#toggle').textContent()).includes('关闭')), '弹窗按钮变为「关闭对照翻译」');
const R = () => art.frames().find((f) => f.name().startsWith('__pt:R:'));
await pop.fill('#f-apiKey', 'sk-test');
check(await waitFor(async () => (await R().evaluate(() => document.body.innerText)).includes('译:')), '在弹窗填入 Key 后，已打开的分屏自动重试并出现译文');
await pop.selectOption('#engine', 'mock');
check(await waitFor(async () => { const f = R(); return f && (await f.evaluate(() => document.body ? document.body.innerText : '').catch(() => '')).includes('【zh-CN】'); }), '在弹窗切换引擎，右侧立即用新引擎重翻');
await pop.click('#test');
check(await waitFor(async () => (await pop.locator('#testOut').textContent()).startsWith('成功')), '弹窗「测试连接」可用', await pop.locator('#testOut').textContent());
// 中英切换：弹窗与已打开分屏的顶栏一起切换
await pop.click('#uiLang button[data-v="en"]');
check(await waitFor(async () => (await pop.locator('#toggle').textContent()) === 'Close Duet-Translator' && (await pop.locator('#test').textContent()) === 'Test connection'), '弹窗切到英文');
check(await waitFor(async () => /paragraphs translated/.test(await status())), '已打开分屏的顶栏同步切到英文', await status());
const ctxTitle = await sw.evaluate(() => globalThis.PT.t('ctx.menu'));
check(ctxTitle.startsWith('Duet-Translator:'), '右键菜单文字随之切换', ctxTitle);
await pop.click('#uiLang button[data-v="zh"]');
check(await waitFor(async () => /已翻译/.test(await status()) && (await pop.locator('#toggle').textContent()) === '关闭对读'), '切回中文');
await pop.click('#toggle');
check(await waitFor(async () => !(await art.evaluate(() => !!document.querySelector('pt-split-root')))), '弹窗按钮关闭分屏');
await pop.selectOption('#engine', 'deepseek');
await pop.setViewportSize({ width: 348, height: 470 });
for (const l of ['en', 'zh']) {
  await pop.click(`#uiLang button[data-v="${l}"]`);
  await new Promise((r) => setTimeout(r, 400));
  await pop.screenshot({ path: join(here, 'out', `popup-${l}.png`) });
}
check(errs.length === 0, '弹窗无 JS 报错', errs);
await ctx.close(); srv.close(); rmSync(dir, { recursive: true, force: true });
console.log(fail ? `${fail} 项失败` : '全部通过'); process.exit(fail ? 1 : 0);
