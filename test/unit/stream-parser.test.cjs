const test = require('node:test');
const assert = require('node:assert/strict');
// providers.js 是给 SW 用的经典脚本：在 node 里提供最小的 PT 环境后加载
globalThis.PT = { t: (k) => k };
require('../../extension/background/providers.js');
const { arrayStreamParser, parseArray } = globalThis.PT.providerUtil;

function feed(text, chunk, max = 99) {
  const got = [];
  const p = arrayStreamParser((k, v) => got.push([k, v]), max);
  for (let i = 0; i < text.length; i += chunk) p.push(text.slice(i, i + chunk));
  return got;
}

test('逐字符到达：每个元素闭合时立刻回调，顺序与下标正确', () => {
  const arr = ['你好，<g1>世界</g1>！', '两个窗格同步滚动。', 'third'];
  const got = feed(JSON.stringify(arr), 1);
  assert.deepEqual(got, arr.map((v, i) => [i, v]));
});

test('跳过 <think> 与 ```json 代码块；think 里的 [ 不算数组开头', () => {
  const arr = ['a', 'b'];
  const text = '<think>plan: use [brackets] here</think>\n```json\n' + JSON.stringify(arr) + '\n```';
  for (const chunk of [1, 3, 7, 1000]) assert.deepEqual(feed(text, chunk), [[0, 'a'], [1, 'b']]);
});

test('字符串内的转义引号、反斜杠、方括号不影响解析', () => {
  const arr = ['say \"hi\" [x]', 'back\\\\slash', 'line\nbreak', '{not an object}'];
  assert.deepEqual(feed(JSON.stringify(arr), 2).map((x) => x[1]), arr);
});

test('think 未闭合前不回调', () => {
  const got = [];
  const p = arrayStreamParser((k, v) => got.push(v), 9);
  p.push('<think>still thinking ["x"]');
  assert.equal(got.length, 0);
  p.push('</think>["ok"]');
  assert.deepEqual(got, ['ok']);
});

test('元素是对象时不回调（交给最终整体解析）；超过 max 的不回调', () => {
  assert.deepEqual(feed('[{"text":"a"},"b"]', 1), [[1, 'b']]);
  assert.deepEqual(feed('[1, null, "c"]', 1), [[2, 'c']]);
  assert.deepEqual(feed('["a","b","c"]', 1, 2), [[0, 'a'], [1, 'b']]);
});

test('最终整体解析仍兼容 think 与代码块', () => {
  assert.deepEqual(parseArray('<think>x</think>```json\n["a","b"]\n```', 2), ['a', 'b']);
  assert.equal(parseArray('["a"]', 2), null);
});
