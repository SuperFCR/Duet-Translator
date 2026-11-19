// 缓存淘汰策略对比：用合成的浏览轨迹（约 4 个月）在固定容量下比较命中率。纯 node，不需要浏览器。
//   node bench/cache-policy.mjs            默认容量 40k 条
//   CAP=20000 DAYS=120 node bench/cache-policy.mjs
//
// 轨迹模型（可调参数在下面）：
//   · SITES 个网站，访问频率服从 Zipf；每个网站有 NAV 条导航 / 菜单 / 页脚短句，所有页面共用
//   · COMMON 条跨站通用短句（Reply / Share / Sign in…），每次访问随机出现几条（Zipf）
//   · 每次访问：REVISIT 概率回到该站最近读过的页面（越近越可能），否则读一篇新文章（PARAS 段全新原文）
//   · 每天 VISITS 次访问
// 命中率 = 命中的查找 / 全部查找；首次出现（必然未命中）对所有策略相同，另给出"可命中部分"的命中率。
const CAP = +process.env.CAP || 40000;
const DAYS = +process.env.DAYS || 120;
const SCAN = +process.env.SCAN || 0;
const SITES = 25, NAV = 40, COMMON = 60, PARAS = 30, VISITS = 40, REVISIT = 0.3;

function rng(seed) { return () => { seed |= 0; seed = (seed + 0x6D2B79F5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
function zipf(n, s, r) {
  const w = Array.from({ length: n }, (_, i) => 1 / Math.pow(i + 1, s));
  const tot = w.reduce((a, b) => a + b, 0);
  const cdf = []; let c = 0; for (const x of w) { c += x / tot; cdf.push(c); }
  return () => { const u = r(); let lo = 0, hi = n - 1; while (lo < hi) { const m = (lo + hi) >> 1; if (cdf[m] < u) lo = m + 1; else hi = m; } return lo; };
}

/** 生成访问轨迹：[[key…], …]，每个元素是一次页面访问要查的段落 key */
function makeTrace() {
  const r = rng(42);
  const pickSite = zipf(SITES, 1.0, r), pickCommon = zipf(COMMON, 1.2, r);
  const pages = Array.from({ length: SITES }, () => []);
  let pageSeq = 0;
  const visits = [];
  for (let d = 0; d < DAYS; d++) {
    for (let v = 0; v < VISITS; v++) {
      const s = pickSite();
      let page;
      if (pages[s].length && r() < REVISIT) {
        const k = Math.min(pages[s].length - 1, Math.floor(-Math.log(1 - r()) * 4));   // 越近越可能
        page = pages[s][pages[s].length - 1 - k];
      } else { page = 'p' + (pageSeq++); pages[s].push(page); }
      const keys = [];
      for (let i = 0; i < NAV; i++) keys.push(`nav${s}.${i}`);
      for (let i = 0; i < 4; i++) keys.push('c' + pickCommon());
      for (let i = 0; i < PARAS; i++) keys.push(`${page}.${i}`);
      visits.push({ day: d, keys: [...new Set(keys)] });
    }
    // SCAN=n：每隔 10 天有一次"全文翻译超长页面"（n 段一次性原文，之后再也不读），检验抗"扫描污染"
    if (SCAN && d % 10 === 5) visits.push({ day: d, keys: Array.from({ length: SCAN }, (_, i) => `scan${d}.${i}`) });
  }
  return visits;
}

/* 策略：entries: Map(key -> {t, ins, h}) ；prune 时按策略选出要删的 */
const POLICIES = {
  'FIFO（旧版：按写入时间）': { touch: false, order: (a, b) => a[1].ins - b[1].ins },
  'LRU': { touch: true, order: (a, b) => a[1].t - b[1].t },
  'LFU（命中少的先删）': { touch: true, order: (a, b) => (a[1].h - b[1].h) || (a[1].t - b[1].t) },
  'LRU + 第二次机会（新版）': { touch: true, order: (a, b) => a[1].t - b[1].t, secondChance: true },
};

function run(trace, pol) {
  const m = new Map();
  let clock = 0, puts = 0, hits = 0, lookups = 0, firstSeen = 0;
  const seen = new Set();
  const prune = () => {
    if (m.size <= CAP) return;
    let drop = m.size - Math.floor(CAP * 0.9);
    const arr = Array.from(m).sort(pol.order);
    for (const [k, e] of arr) {
      if (drop <= 0) break;
      if (pol.secondChance && e.h >= 2) { e.h = Math.floor(e.h / 2); e.t = Math.floor((e.t + clock) / 2); continue; }
      m.delete(k); drop--;
    }
    // 第二次机会把一部分条目挪后了：还没删够就按新顺序再删（与 IndexedDB 游标继续前进的效果一致）
    if (drop > 0) for (const [k] of Array.from(m).sort((a, b) => a[1].t - b[1].t)) { if (drop-- <= 0) break; m.delete(k); }
  };
  for (const v of trace) {
    for (const k of v.keys) {
      clock++; lookups++;
      if (!seen.has(k)) { seen.add(k); firstSeen++; }
      const e = m.get(k);
      if (e) { hits++; if (pol.touch) { e.t = clock; e.h++; } continue; }
      m.set(k, { t: clock, ins: clock, h: 0 });
      if (++puts % 200 === 0) prune();
    }
  }
  return { hitRate: hits / lookups, reachable: hits / (lookups - firstSeen), lookups, unique: firstSeen };
}

const trace = makeTrace();
const results = Object.entries(POLICIES).map(([name, pol]) => [name, run(trace, pol)]);
const { lookups, unique } = results[0][1];
console.log(`${SCAN ? `含扫描：每 10 天一次 ${SCAN} 段一次性原文；` : ''}轨迹：${DAYS} 天，${trace.length} 次页面访问，${lookups.toLocaleString()} 次段落查找，${unique.toLocaleString()} 条不同原文；容量 ${CAP.toLocaleString()} 条\n`);
console.log('| 策略 | 命中率（全部查找） | 命中率（去掉首次出现） |');
console.log('|---|---|---|');
for (const [name, r] of results) console.log(`| ${name} | ${(r.hitRate * 100).toFixed(1)}% | ${(r.reachable * 100).toFixed(1)}% |`);
