/* cache.js — IndexedDB 译文缓存：key = sha1(引擎|模型|源语言|目标语言|原文) */
(function (root) {
  'use strict';
  const DB = 'duet', STORE = 'tr', MAX = 60000;
  let dbp = null;

  function open() {
    if (dbp) return dbp;
    dbp = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB, 1);
      req.onupgradeneeded = () => {
        const s = req.result.createObjectStore(STORE, { keyPath: 'k' });
        s.createIndex('t', 't');
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    return dbp;
  }

  async function sha1(s) {
    const buf = await crypto.subtle.digest('SHA-1', new TextEncoder().encode(s));
    return Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, '0')).join('');
  }

  const reqP = (r) => new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });

  async function keys(prefix, texts) {
    return Promise.all(texts.map((t) => sha1(prefix + '\u0000' + t)));
  }

  async function getMany(ks) {
    const db = await open();
    const st = db.transaction(STORE, 'readonly').objectStore(STORE);
    const rows = await Promise.all(ks.map((k) => reqP(st.get(k))));
    return rows.map((r) => (r ? r.v : undefined));
  }

  let puts = 0;
  async function putMany(ks, vs) {
    const db = await open();
    const tx = db.transaction(STORE, 'readwrite');
    const st = tx.objectStore(STORE);
    const t = Date.now();
    ks.forEach((k, i) => st.put({ k, v: vs[i], t }));
    await new Promise((res, rej) => { tx.oncomplete = res; tx.onerror = () => rej(tx.error); });
    if (++puts % 100 === 0) prune().catch(() => {});
  }

  async function prune() {
    const db = await open();
    const st = db.transaction(STORE, 'readwrite').objectStore(STORE);
    const n = await reqP(st.count());
    if (n <= MAX) return;
    let drop = n - Math.floor(MAX * 0.9);
    await new Promise((res) => {
      const cur = st.index('t').openCursor();
      cur.onsuccess = () => {
        const c = cur.result;
        if (!c || drop-- <= 0) return res();
        c.delete();
        c.continue();
      };
      cur.onerror = res;
    });
  }

  async function clear() {
    const db = await open();
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).clear();
    await new Promise((res) => { tx.oncomplete = res; });
  }

  async function count() {
    const db = await open();
    return reqP(db.transaction(STORE, 'readonly').objectStore(STORE).count());
  }

  root.PT.cache = { keys, getMany, putMany, clear, count };
})(globalThis);
