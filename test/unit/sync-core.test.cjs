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

test('并排的浮动图注不干扰正文段落内部的对齐', () => {
  // 左：正文 P1 [100,300]，旁边浮动图注 C [150,180]；右：P1 译文变长 [100,500]，图注 [150,210]
  const A = [{ k: 'P1', t: 100, b: 300 }, { k: 'C', t: 150, b: 180 }, { k: 'P2', t: 320, b: 400 }];
  const B = [{ k: 'P1', t: 100, b: 500 }, { k: 'C', t: 150, b: 210 }, { k: 'P2', t: 520, b: 640 }];
  const m = S.createMapper(S.buildPairs(A, B, { HA: 600, HB: 900 }));
  // 读到 P1 的一半（左 200）→ 右侧应该在 P1 的一半（300），而不是被图注拉偏
  assert.ok(Math.abs(m.LtoR(200) - 300) < 1e-6, String(m.LtoR(200)));
  assert.ok(Math.abs(m.LtoR(320) - 520) < 1e-6);
});

test('上下堆叠的普通段落不会被误判为并排', () => {
  const A = [{ k: 'a', t: 0, b: 100 }, { k: 'b', t: 110, b: 200 }, { k: 'c', t: 210, b: 400 }];
  const kept = S.dropSideBySide(A.map((x) => [x, x]));
  assert.equal(kept.length, 3);
});

test('与正文同一高度起始的浮动元素也被去掉', () => {
  const A = [{ k: 'P1', t: 100, b: 300 }, { k: 'C', t: 100, b: 160 }];
  const B = [{ k: 'P1', t: 100, b: 500 }, { k: 'C', t: 100, b: 220 }];
  const m = S.createMapper(S.buildPairs(A, B, { HA: 600, HB: 900 }));
  assert.ok(Math.abs(m.LtoR(200) - 300) < 1e-6, String(m.LtoR(200)));
});

test('跨在两段正文之间的信息框行被去掉，正文段内对齐不受影响', () => {
  // 左：P1 [100,300]、P2 [310,500]，信息框行 R1 [290,330] 跨在两段之间；右：正文变长，信息框行几乎不变
  const A = [{ k: 'P1', t: 100, b: 300, n: 800 }, { k: 'R1', t: 290, b: 330, n: 20 }, { k: 'P2', t: 310, b: 500, n: 700 }];
  const B = [{ k: 'P1', t: 100, b: 500, n: 800 }, { k: 'R1', t: 290, b: 350, n: 20 }, { k: 'P2', t: 520, b: 900, n: 700 }];
  const m = S.createMapper(S.buildPairs(A, B, { HA: 600, HB: 1000 }));
  assert.ok(Math.abs(m.LtoR(200) - 300) < 1e-6, 'P1 中点 ' + m.LtoR(200));
  assert.ok(Math.abs(m.LtoR(405) - 710) < 1e-6, 'P2 中点 ' + m.LtoR(405));
});

test('表格同一行的多个单元格只保留文字最多的一个', () => {
  const A = [{ k: 'a', t: 0, b: 40, n: 5 }, { k: 'b', t: 0, b: 40, n: 50 }, { k: 'c', t: 50, b: 90, n: 30 }, { k: 'd', t: 50, b: 90, n: 3 }];
  const kept = S.dropSideBySide(A.map((x) => [x, x])).map((p) => p[0].k);
  assert.deepEqual(kept.sort(), ['b', 'c']);
});
