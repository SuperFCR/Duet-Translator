const test = require('node:test');
const assert = require('node:assert/strict');
const S = require('../../extension/shared/sync-core.js');

// 构造一页：n 段，左侧段高 hL[i]，右侧段高 hR[i]，段间距 gap
function page(hs, gap = 16, top = 80) {
  let y = top; const a = [];
  hs.forEach((h, i) => { a.push({ k: 'p' + i, t: y, b: y + h }); y += h + gap; });
  return { anchors: a, H: y + 200 };
}

test('lisIndices 取最长严格递增子序列', () => {
  const ys = [1, 5, 2, 3, 9, 4, 10];
  const idx = S.lisIndices(ys);
  const seq = idx.map((i) => ys[i]);
  assert.equal(seq.length, 5);
  for (let i = 1; i < seq.length; i++) assert.ok(seq[i] > seq[i - 1]);
});

test('相同布局 → 恒等映射', () => {
  const L = page([40, 60, 80, 20]);
  const m = S.createMapper(S.buildPairs(L.anchors, L.anchors, { HA: L.H, HB: L.H }));
  for (const y of [0, 10, 100, 250, L.H]) assert.ok(Math.abs(m.LtoR(y) - y) < 1e-6);
});

test('译文段落更高：段首段尾都对齐，段内按比例', () => {
  const hL = [40, 60, 80, 20, 100], hR = hL.map((h, i) => h * (i % 2 ? 2 : 1.5));
  const L = page(hL), R = page(hR);
  const m = S.createMapper(S.buildPairs(L.anchors, R.anchors, { HA: L.H, HB: R.H }));
  L.anchors.forEach((a, i) => {
    const b = R.anchors[i];
    assert.ok(Math.abs(m.LtoR(a.t) - b.t) < 1e-6, 'top ' + i);
    assert.ok(Math.abs(m.LtoR(a.b) - b.b) < 1e-6, 'bottom ' + i);
    assert.ok(Math.abs(m.LtoR((a.t + a.b) / 2) - (b.t + b.b) / 2) < 1e-6, 'mid ' + i);
    assert.ok(Math.abs(m.RtoL(m.LtoR(a.t + 7)) - (a.t + 7)) < 1e-6, 'inverse ' + i);
  });
  assert.equal(m.LtoR(0), 0);
  assert.ok(Math.abs(m.LtoR(L.H) - R.H) < 1e-6);
});

test('非单调的坏锚点（吸顶元素/乱序）被 LIS 剔除', () => {
  const L = page([50, 50, 50, 50, 50, 50]);
  const R = page([90, 90, 90, 90, 90, 90]);
  // 左边 p2 与 p4 的 key 在右边对调（模拟动态内容不一致）
  const Rb = R.anchors.map((a) => ({ ...a }));
  [Rb[2].k, Rb[4].k] = [Rb[4].k, Rb[2].k];
  const pts = S.buildPairs(L.anchors, Rb, { HA: L.H, HB: R.H });
  for (let i = 1; i < pts.length; i++) {
    assert.ok(pts[i][0] > pts[i - 1][0] && pts[i][1] > pts[i - 1][1], 'strictly increasing');
  }
  const m = S.createMapper(pts);
  // 未受影响的段仍精确对齐
  for (const i of [0, 1, 5]) assert.ok(Math.abs(m.LtoR(L.anchors[i].t) - R.anchors[i].t) < 1e-6);
});

test('followerScrollTop：同时到顶、同时到底、中间焦点线内容对齐', () => {
  const hL = Array.from({ length: 40 }, (_, i) => 30 + (i * 37) % 70);
  const hR = hL.map((h, i) => h * (1.2 + (i % 4) * 0.3));
  const L = page(hL), R = page(hR);
  const m = S.createMapper(S.buildPairs(L.anchors, R.anchors, { HA: L.H, HB: R.H }));
  const vh = 700;
  const dL = (t) => ({ t, vh, H: L.H }), fR = { t: 0, vh, H: R.H };
  assert.equal(S.followerScrollTop(dL(0), fR, m.LtoR), 0);
  assert.ok(Math.abs(S.followerScrollTop(dL(L.H - vh), fR, m.LtoR) - (R.H - vh)) < 1e-6);
  for (const t of [300, 900, 1500, 2200]) {
    const tR = S.followerScrollTop(dL(t), fR, m.LtoR);
    const pL = t + (t / (L.H - vh)) * vh;             // 左焦点线
    const pR = tR + (tR / (R.H - vh)) * vh;           // 右焦点线
    assert.ok(Math.abs(m.LtoR(pL) - pR) < 1e-6, 'focus aligned at t=' + t);
  }
  // 单调：左边越往下，右边也越往下
  let prev = -1;
  for (let t = 0; t <= L.H - vh; t += 25) {
    const tR = S.followerScrollTop(dL(t), fR, m.LtoR);
    assert.ok(tR >= prev); prev = tR;
  }
});

test('无匹配锚点时退化为按比例滚动', () => {
  const m = S.createMapper(S.buildPairs([], [], { HA: 1000, HB: 3000 }));
  const t = S.followerScrollTop({ t: 150, vh: 500, H: 1000 }, { t: 0, vh: 500, H: 3000 }, m.LtoR);
  assert.ok(Math.abs(t / 2500 - 150 / 500) < 1e-9);
});
