/*
 * sync-core.js — 纯函数，无 DOM 依赖（可在 node 中单测）。
 *
 * 两个窗格(L=原文, R=译文)各自上报 anchors: [{k, t, b}]
 *   k = 段落 key（原文文本哈希 + 出现序号，两边一致）
 *   t/b = 该段落在"滚动内容坐标系"中的上/下边界(px)
 *
 * 1) buildPairs: 按 key 配对，得到 (yL, yR) 点集；用 LIS 去掉非单调的点
 *    （固定/吸顶元素、多栏布局、两边动态内容不一致都会产生这类"坏锚点"）。
 * 2) Mapper: 在点集上做分段线性插值，L→R 或 R→L。
 * 3) followerScrollTop: "滑动焦点线"——焦点线在视口中的相对位置 = 当前滚动进度。
 *    页顶时焦点线在视口顶部，页底时在视口底部，因此两边总是同时到顶/到底，
 *    中间部分则保证焦点线处的内容对齐。
 */
(function (root) {
  'use strict';

  /** 严格递增 LIS（按 ys），返回被选中元素的下标 */
  function lisIndices(ys) {
    const n = ys.length;
    const tailsIdx = [];          // tailsIdx[len-1] = 长度为 len 的递增子序列的末尾下标
    const prev = new Int32Array(n).fill(-1);
    for (let i = 0; i < n; i++) {
      const y = ys[i];
      let lo = 0, hi = tailsIdx.length;
      while (lo < hi) {           // 第一个 ys[tail] >= y 的位置（严格递增）
        const mid = (lo + hi) >> 1;
        if (ys[tailsIdx[mid]] < y) lo = mid + 1; else hi = mid;
      }
      if (lo > 0) prev[i] = tailsIdx[lo - 1];
      tailsIdx[lo] = i;
    }
    const out = new Array(tailsIdx.length);
    let k = tailsIdx.length ? tailsIdx[tailsIdx.length - 1] : -1;
    for (let j = tailsIdx.length - 1; j >= 0; j--) { out[j] = k; k = prev[k]; }
    return out;
  }

  /**
   * @param {Array<{k:string,t:number,b:number}>} A  L 窗格锚点
   * @param {Array<{k:string,t:number,b:number}>} B  R 窗格锚点
   * @param {{HA:number, HB:number, minGap?:number}} dims  两边内容总高度
   * @returns {Array<[number, number]>} 单调点集，含端点 (0,0) 与 (HA,HB)
   */
  function buildPairs(A, B, dims) {
    const { HA, HB } = dims;
    const minGap = dims.minGap ?? 0.5;
    const mapB = new Map();
    for (const a of B) if (!mapB.has(a.k)) mapB.set(a.k, a);

    const raw = [];
    for (const a of A) {
      const b = mapB.get(a.k);
      if (!b) continue;
      raw.push([a.t, b.t]);
      // 段落内部也按比例对齐：上下边界都作为锚点
      if (a.b - a.t > 1 && b.b - b.t > 1) raw.push([a.b, b.b]);
    }
    // 只保留严格位于内容内部的点，端点稍后显式加入
    const inner = raw.filter(([x, y]) => x > minGap && y > minGap && x < HA - minGap && y < HB - minGap);
    inner.sort((p, q) => p[0] - q[0] || p[1] - q[1]);

    // x 相同的点只保留一个（取第一个），保证 x 严格递增
    const dedup = [];
    for (const p of inner) {
      if (dedup.length && p[0] - dedup[dedup.length - 1][0] < minGap) continue;
      dedup.push(p);
    }
    const keep = lisIndices(dedup.map((p) => p[1]));
    const pts = [[0, 0]];
    for (const i of keep) {
      const p = dedup[i];
      const last = pts[pts.length - 1];
      if (p[0] - last[0] >= minGap && p[1] - last[1] >= minGap) pts.push(p);
    }
    const end = [Math.max(HA, pts[pts.length - 1][0] + minGap), Math.max(HB, pts[pts.length - 1][1] + minGap)];
    pts.push(end);
    return pts;
  }

  /** 分段线性插值；pts 的两个坐标都严格递增 */
  function interp(pts, x, from, to) {
    const n = pts.length;
    if (n === 0) return x;
    if (x <= pts[0][from]) return pts[0][to] + (x - pts[0][from]);
    if (x >= pts[n - 1][from]) return pts[n - 1][to] + (x - pts[n - 1][from]);
    let lo = 0, hi = n - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (pts[mid][from] <= x) lo = mid; else hi = mid;
    }
    const x0 = pts[lo][from], x1 = pts[hi][from];
    const y0 = pts[lo][to], y1 = pts[hi][to];
    return y0 + ((x - x0) / (x1 - x0)) * (y1 - y0);
  }

  function createMapper(pts) {
    return {
      points: pts,
      LtoR: (y) => interp(pts, y, 0, 1),
      RtoL: (y) => interp(pts, y, 1, 0),
    };
  }

  /**
   * 由驱动方滚动状态计算跟随方 scrollTop。
   * state: {t: scrollTop, vh: 可视高度, H: 内容总高度}
   * map:   驱动方内容坐标 → 跟随方内容坐标
   */
  function followerScrollTop(driver, follower, map) {
    const maxD = Math.max(0, driver.H - driver.vh);
    const maxF = Math.max(0, follower.H - follower.vh);
    if (maxF === 0) return 0;
    const r = maxD > 0 ? clamp(driver.t / maxD, 0, 1) : 0;
    const p = driver.t + r * driver.vh;          // 驱动方焦点线（内容坐标）
    const q = map(p);                             // 跟随方对应位置
    // 解 t' + (t'/maxF)·vhF = q  →  t' = q·maxF / HF
    const tF = (q * maxF) / (maxF + follower.vh);
    return clamp(tF, 0, maxF);
  }

  function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }

  /** FNV-1a 32bit → base36，用于段落 key */
  function hashText(s) {
    let h = 0x811c9dc5;
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 0x01000193);
    }
    return (h >>> 0).toString(36);
  }

  const api = { lisIndices, buildPairs, createMapper, interp, followerScrollTop, hashText, clamp };
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.PT = root.PT || {};
  root.PT.sync = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
