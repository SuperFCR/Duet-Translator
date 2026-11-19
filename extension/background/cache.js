/*
 * cache.js — 译文缓存（两级）
 *   L1：SW 内存 LRU（热点段落：导航、按钮、反复出现的短句），省掉 sha1 + IndexedDB 往返
 *   L2：IndexedDB，key = sha1(命名空间 + 原文)，命名空间 = 引擎|模型|源语言|目标语言[|自定义提示词哈希]
 *
 * 淘汰（prune）—— 每 200 次写入、SW 启动后、存储吃紧时运行：
 *   1. TTL：超过 ttlDays 天没被读过的条目直接删除（换了模型、只看过一次的页面，自然过期）
 *   2. 预算：条目数 > maxEntries 或体积 > maxMB 时，按"最近访问时间"从旧到新淘汰到 90%；
 *      命中过 ≥2 次的条目给"第二次机会"：命中数减半、访问时间往回挪一半，而不是立刻删除
 *      （常访问网站的导航 / 菜单等高复用短句，不会被一篇长文的一次性译文冲掉）
 *   3. 浏览器存储占用 > 80% 配额时，目标降到 50%
 * 命中（内存层或 IndexedDB）都回写访问时间与命中数：每个 key 在一次 SW 生命周期里最多记一次，2 秒批量写入。
 */
(function (root) {
  'use strict';
  const DB = 'duet', STORE = 'tr', META = 'meta';
  const L1_MAX = 4000;
  const DEF = { maxEntries: 80000, maxMB: 64, ttlDays: 90 };
  let dbp = null;

  function open() {
    if (dbp) return dbp;
    dbp = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB, 2);
      req.onupgradeneeded = (ev) => {
        const db = req.result;
        const st = ev.oldVersion < 1 ? db.createObjectStore(STORE, { keyPath: 'k' }) : req.transaction.objectStore(STORE);
        if (!st.indexNames.contains('t')) st.createIndex('t', 't');
        if (!st.indexNames.contains('host')) st.createIndex('host', 'host');
        if (!st.indexNames.contains('ns')) st.createIndex('ns', 'ns');
        if (!st.indexNames.contains('page')) st.createIndex('page', 'page');
        if (!db.objectStoreNames.contains(META)) db.createObjectStore(META, { keyPath: 'id' });
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => { dbp = null; reject(req.error); };
    });
    return dbp;
  }

  async function sha1(s) {
    const buf = await crypto.subtle.digest('SHA-1', new TextEncoder().encode(s));
    return Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, '0')).join('');
  }
  const reqP = (r) => new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
  const txDone = (tx) => new Promise((res, rej) => { tx.oncomplete = res; tx.onerror = () => rej(tx.error); tx.onabort = () => rej(tx.error); });

  /* ------------------------------ L1 内存 LRU ------------------------------ */
  const l1 = new Map();   // k -> v（Map 保持插入顺序，重新插入 = 移到最新）
  function l1Get(k) {
    if (!l1.has(k)) return undefined;
    const v = l1.get(k);
    l1.delete(k); l1.set(k, v);
    return v;
  }
  function l1Set(k, v) {
    l1.delete(k); l1.set(k, v);
    if (l1.size > L1_MAX) l1.delete(l1.keys().next().value);
  }

  /* ------------------------------ 统计 ------------------------------ */
  // 会话内计数，定期合并进 META；用于设置页展示命中率与"缓存省下的字符"
  const stats = { hits: 0, misses: 0, savedChars: 0, l1Hits: 0 };
  let statsDirty = false, statsTimer = 0;
  function bumpStats() {
    statsDirty = true;
    if (!statsTimer) statsTimer = setTimeout(flushStats, 5000);
  }
  async function flushStats() {
    statsTimer = 0;
    if (!statsDirty) return;
    statsDirty = false;
    const d = { hits: stats.hits, misses: stats.misses, savedChars: stats.savedChars };
    stats.hits = stats.misses = stats.savedChars = 0;
    try {
      const db = await open();
      const tx = db.transaction(META, 'readwrite');
      const st = tx.objectStore(META);
      const cur = (await reqP(st.get('stats'))) || { id: 'stats', hits: 0, misses: 0, savedChars: 0, since: Date.now() };
      cur.hits += d.hits; cur.misses += d.misses; cur.savedChars += d.savedChars;
      st.put(cur);
      await txDone(tx);
    } catch (_) { /* 统计丢了无所谓 */ }
  }

  /* ------------------------------ 读写 ------------------------------ */
  async function keys(prefix, texts) {
    return Promise.all(texts.map((t) => sha1(prefix + '\u0000' + t)));
  }

  const touchQ = new Map();   // k -> 命中次数增量（批量回写访问时间）
  const touchedThisRun = new Set();   // 本次 SW 生命周期里已登记过的 key：每个 key 每次最多记一次命中，写入量有上限
  let touchTimer = 0;
  function touch(k) {
    if (touchedThisRun.has(k)) return;
    touchedThisRun.add(k);
    if (touchedThisRun.size > 20000) touchedThisRun.clear();
    touchQ.set(k, (touchQ.get(k) || 0) + 1);
  }
  async function flushTouch() {
    touchTimer = 0;
    if (!touchQ.size) return;
    const items = Array.from(touchQ); touchQ.clear();
    try {
      const db = await open();
      const tx = db.transaction(STORE, 'readwrite');
      const st = tx.objectStore(STORE);
      const t = Date.now();
      await Promise.all(items.map(async ([k, n]) => {
        const r = await reqP(st.get(k));
        if (r) { r.t = t; r.h = (r.h || 0) + n; st.put(r); }
      }));
      await txDone(tx);
    } catch (_) { /* noop */ }
  }

  /** texts 可选：用于统计"省下的字符数" */
  async function getMany(ks, texts) {
    // 注意：不能用 new Array(n) + forEach 统计未命中 —— forEach 会跳过空洞，未命中永远不被计数
    const out = Array.from({ length: ks.length }, () => undefined);
    const need = [];
    ks.forEach((k, i) => {
      const v = l1Get(k);
      // 内存层命中也要回写访问时间 / 命中数，否则热点条目在 IndexedDB 里看起来是"冷"的，会被 LRU 先淘汰
      if (v !== undefined) { out[i] = v; stats.l1Hits++; touch(k); } else need.push(i);
    });
    if (need.length) {
      const db = await open();
      const st = db.transaction(STORE, 'readonly').objectStore(STORE);
      const rows = await Promise.all(need.map((i) => reqP(st.get(ks[i]))));
      rows.forEach((r, j) => {
        if (!r) return;
        const i = need[j];
        out[i] = r.v;
        l1Set(ks[i], r.v);
        touch(ks[i]);
      });
    }
    if (touchQ.size && !touchTimer) touchTimer = setTimeout(flushTouch, 2000);
    out.forEach((v, i) => {
      if (v === undefined) stats.misses++;
      else { stats.hits++; if (texts) stats.savedChars += texts[i].length; }
    });
    bumpStats();
    return out;
  }

  let puts = 0;
  /** meta: { host, page, ns } —— 用于按网站 / 按页面 / 按引擎清理 */
  async function putMany(ks, vs, meta) {
    const db = await open();
    const tx = db.transaction(STORE, 'readwrite');
    const st = tx.objectStore(STORE);
    const t = Date.now();
    const host = (meta && meta.host) || '', ns = (meta && meta.ns) || '', page = (meta && meta.page) || '';
    ks.forEach((k, i) => {
      const v = vs[i];
      if (typeof v !== 'string') return;
      l1Set(k, v);
      st.put({ k, v, t, h: 0, n: v.length * 2 + 120, host, page, ns });
    });
    await txDone(tx);
    puts += ks.length;
    if (puts >= 200) { puts = 0; prune().catch(() => {}); }
  }

  async function deleteKeys(ks) {
    ks.forEach((k) => l1.delete(k));
    const db = await open();
    const tx = db.transaction(STORE, 'readwrite');
    ks.forEach((k) => tx.objectStore(STORE).delete(k));
    await txDone(tx);
  }

  /* ------------------------------ 淘汰 ------------------------------ */
  let limits = Object.assign({}, DEF);
  function configure(o) {
    limits = Object.assign({}, DEF);
    for (const k of Object.keys(DEF)) if (o && Number(o[k]) > 0) limits[k] = Number(o[k]);
  }

  let pruning = null;
  function prune(opts) {
    if (!pruning) pruning = pruneInner(opts || {}).finally(() => { pruning = null; });
    return pruning;
  }
  async function pruneInner(opts) {
    const db = await open();
    const now = Date.now();
    const ttlCut = now - limits.ttlDays * 86400e3;
    let factor = 0.9;
    try {
      const est = navigator.storage && navigator.storage.estimate ? await navigator.storage.estimate() : null;
      if (est && est.quota && est.usage / est.quota > 0.8) factor = 0.5;   // 存储吃紧：多腾一些
    } catch (_) { /* noop */ }
    if (opts.factor) factor = opts.factor;
    const res = { expired: 0, evicted: 0, spared: 0, count: 0, bytes: 0 };

    // 第 1 遍：按访问时间升序扫，删过期条目，同时统计总量
    await new Promise((resolve) => {
      const tx = db.transaction(STORE, 'readwrite');
      const cur = tx.objectStore(STORE).index('t').openCursor();
      cur.onsuccess = () => {
        const c = cur.result;
        if (!c) return;
        const r = c.value;
        if ((r.t || 0) < ttlCut) { c.delete(); l1.delete(r.k); res.expired++; }
        else { res.count++; res.bytes += r.n || ((r.v || '').length * 2 + 120); }
        c.continue();
      };
      tx.oncomplete = resolve; tx.onerror = resolve; tx.onabort = resolve;
    });

    // 第 2 遍：超预算 → 从最久没访问的开始淘汰，高复用条目给第二次机会
    const maxB = limits.maxMB * 1048576, maxN = limits.maxEntries;
    if (res.count > maxN || res.bytes > maxB) {
      let dropN = res.count - Math.floor(maxN * factor), dropB = res.bytes - Math.floor(maxB * factor);
      await new Promise((resolve) => {
        const tx = db.transaction(STORE, 'readwrite');
        const cur = tx.objectStore(STORE).index('t').openCursor();
        cur.onsuccess = () => {
          const c = cur.result;
          if (!c || (dropN <= 0 && dropB <= 0)) return;
          const r = c.value;
          if ((r.h || 0) >= 2) {
            // 第二次机会：命中数减半，访问时间挪到"现在与原时间的中点"。被挪到索引后方，本轮不会再遇到
            r.h = Math.floor(r.h / 2);
            r.t = Math.floor((r.t + now) / 2);
            c.update(r);
            res.spared++;
          } else {
            c.delete(); l1.delete(r.k);
            res.evicted++;
            dropN--; dropB -= r.n || 0;
            res.count--; res.bytes -= r.n || 0;
          }
          c.continue();
        };
        tx.oncomplete = resolve; tx.onerror = resolve; tx.onabort = resolve;
      });
    }
    await saveMeta({ id: 'size', count: res.count, bytes: res.bytes, at: now, last: res });
    return res;
  }

  async function saveMeta(rec) {
    try {
      const db = await open();
      const tx = db.transaction(META, 'readwrite');
      tx.objectStore(META).put(rec);
      await txDone(tx);
    } catch (_) { /* noop */ }
  }

  /** 清空：scope 省略 = 全部；{host} 某个网站；{page} 某个页面（最后由该页写入的条目）；{ns} 某个引擎/模型/语言组合；{nsPrefix} 某个引擎的全部 */
  async function clear(scope) {
    const db = await open();
    l1.clear();
    if (!scope || (!scope.host && !scope.page && !scope.ns && !scope.nsPrefix)) {
      const tx = db.transaction([STORE, META], 'readwrite');
      tx.objectStore(STORE).clear();
      tx.objectStore(META).clear();
      await txDone(tx);
      return { removed: -1 };
    }
    let removed = 0;
    await new Promise((resolve) => {
      const tx = db.transaction(STORE, 'readwrite');
      const st = tx.objectStore(STORE);
      let cur;
      if (scope.host) cur = st.index('host').openCursor(IDBKeyRange.only(scope.host));
      else if (scope.page) cur = st.index('page').openCursor(IDBKeyRange.only(scope.page));
      else if (scope.ns) cur = st.index('ns').openCursor(IDBKeyRange.only(scope.ns));
      else cur = st.index('ns').openCursor(IDBKeyRange.bound(scope.nsPrefix, scope.nsPrefix + '￿'));
      cur.onsuccess = () => {
        const c = cur.result;
        if (!c) return;
        c.delete(); l1.delete(c.value.k); removed++;
        c.continue();
      };
      tx.oncomplete = resolve; tx.onerror = resolve; tx.onabort = resolve;
    });
    return { removed };
  }

  async function count() {
    const db = await open();
    return reqP(db.transaction(STORE, 'readonly').objectStore(STORE).count());
  }

  async function info(host) {
    await flushStats();
    const db = await open();
    const tx = db.transaction([STORE, META], 'readonly');
    const st = tx.objectStore(STORE), mt = tx.objectStore(META);
    const [n, s, size, siteN] = await Promise.all([
      reqP(st.count()), reqP(mt.get('stats')), reqP(mt.get('size')),
      host ? reqP(st.index('host').count(IDBKeyRange.only(host))) : Promise.resolve(0),
    ]);
    return {
      count: n,
      bytes: size ? size.bytes : null,
      siteCount: siteN,
      hits: (s ? s.hits : 0) + stats.hits, misses: (s ? s.misses : 0) + stats.misses,
      savedChars: (s ? s.savedChars : 0) + stats.savedChars,
      since: s ? s.since : null,
      limits,
      lastPrune: size ? size.last : null,
      lastPruneAt: size ? size.at : 0,
    };
  }

  root.PT.cache = { keys, getMany, putMany, deleteKeys, clear, count, info, prune, configure, _l1: l1 };
})(globalThis);
