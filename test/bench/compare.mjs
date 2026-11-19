// compare.mjs — 并排比较两个或更多 bench 结果（第一个为基准，其余列给出相对变化）。
//   node bench/compare.mjs baseline current            （= out/baseline.json out/current.json）
//   node bench/compare.mjs out/a.json out/b.json out/c.json
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
if (args.length < 2) { console.error('usage: node bench/compare.mjs <base> <other> [more…]   (label or path to .json)'); process.exit(2); }
const runs = args.map((a) => JSON.parse(readFileSync(a.endsWith('.json') ? a : join(here, 'out', a + '.json'), 'utf8')));

const METRICS = [
  ['requests', 'requests', 0], ['aborted', 'aborted req', 0], ['segs', 'segments sent', 0], ['dupSegs', 'duplicate segs', 0],
  ['missTok', 'input tok (miss)', 0], ['hitTok', 'input tok (hit)', 0], ['outTok', 'output tok', 0],
  ['cost', 'cost USD', 6], ['ttfFirst', 'first translated ms', 0], ['openFull', 'first screen done ms', 0],
  ['waitMean', 'wait mean ms', 0], ['waitP90', 'wait p90 ms', 0], ['capped', 'waits capped', 0],
];
const fmt = (v, d) => (v == null ? '–' : (+v).toFixed(d));
function delta(base, v) {
  if (base == null || v == null) return '';
  if (base === 0) return v === 0 ? '=' : 'new';
  const p = ((v - base) / base) * 100;
  if (Math.abs(p) < 0.05) return '=';
  return (p > 0 ? '+' : '−') + Math.abs(p).toFixed(1) + '%';
}

for (const r of runs) {
  const g = r.git ? r.git.commit + (r.git.dirty ? '+dirty' : '') : '?';
  const p = r.effective ? r.effective.provider : {};
  console.log(`- **${r.label}**: ext ${g} (${r.extDir}); batchChars=${p.batchChars} batchSize=${p.batchSize} concurrency=${p.concurrency}` +
    ` prefetchScreens=${r.effective ? r.effective.settings.prefetchScreens : '?'}` +
    (r.overrides && Object.keys(r.overrides).length ? ` overrides=${JSON.stringify(r.overrides)}` : '') +
    (r.settingsPatch && Object.keys(r.settingsPatch).length ? ` settings=${JSON.stringify(r.settingsPatch)}` : ''));
}
console.log('');
const labels = runs.map((r) => r.label);
const head = ['scenario', 'metric', labels[0], ...labels.slice(1).map((l) => `${l} (Δ vs ${labels[0]})`)];
console.log('| ' + head.join(' | ') + ' |');
console.log('|' + head.map(() => '---').join('|') + '|');
const names = [];
for (const r of runs) for (const n of Object.keys(r.scenarios || {})) if (!names.includes(n)) names.push(n);
names.push('TOTAL');
for (const n of names) {
  const get = (r) => (n === 'TOTAL' ? r.total : r.scenarios && r.scenarios[n]);
  for (const [k, label, d] of METRICS) {
    const vals = runs.map((r) => { const s = get(r); return s && !s.failed ? s[k] : null; });
    if (vals.every((v) => v == null)) continue;
    const cells = [fmt(vals[0], d), ...vals.slice(1).map((v) => `${fmt(v, d)} (${delta(vals[0], v) || '–'})`)];
    console.log(`| ${n} | ${label} | ${cells.join(' | ')} |`);
  }
}
const failed = runs.flatMap((r) => Object.values(r.scenarios || {}).filter((s) => s.failed).map((s) => `${r.label}/${s.name}: ${s.failed}`));
if (failed.length) console.log('\nFAILED: ' + failed.join('; '));
