const test = require('node:test');
const assert = require('node:assert');
const { breakdown } = require('../src/dispense');

test('breakdown 300 with default cassettes → 3x100', () => {
  const r = breakdown(300);
  assert.strictEqual(r.ok, true);
  assert.deepStrictEqual(r.counts, [0, 3, 0, 0]); // C1=50,C2=100,C3=500,C4=1000
  assert.strictEqual(r.fieldG, '00030000');
});

test('breakdown 50 → single 50 note', () => {
  const r = breakdown(50);
  assert.deepStrictEqual(r.counts, [1, 0, 0, 0]);
  assert.strictEqual(r.fieldG, '01000000');
});

test('breakdown 10000 → 10x1000', () => {
  const r = breakdown(10000);
  assert.deepStrictEqual(r.counts, [0, 0, 0, 10]);
  assert.strictEqual(r.fieldG, '00000010');
});

test('amount not dispensable → ok false', () => {
  const r = breakdown(30); // 30 not reachable with [50,100,500,1000]
  assert.strictEqual(r.ok, false);
});

test('zero amount → ok false', () => {
  assert.strictEqual(breakdown(0).ok, false);
});

test('custom cassettes respected', () => {
  const r = breakdown(300, [100, 200]);
  assert.strictEqual(r.ok, true);
  assert.deepStrictEqual(r.counts, [1, 1]); // greedy: 1x200 + 1x100
  assert.strictEqual(r.fieldG, '0101');
});

test('钞箱可按 { value, currency } 声明：只用请求币种的钞箱（CUBC A=USD50 B=USD10 C=KHR50000 D=USD100）', () => {
  const cubc = [
    { value: 50, currency: 'USD' }, { value: 10, currency: 'USD' },
    { value: 50000, currency: 'KHR' }, { value: 100, currency: 'USD' },
  ];
  assert.deepStrictEqual(breakdown(190, cubc, { currency: 'USD' }).counts, [1, 4, 0, 1]);
  assert.deepStrictEqual(breakdown(100000, cubc, { currency: 'KHR' }).counts, [0, 0, 2, 0]);
  assert.strictEqual(breakdown(100000, cubc, { currency: 'USD' }).counts[2], 0);
});

test('slots 把出钞字段补到固定钞箱数（DDC 现网 8 组两位：0104000100000000）', () => {
  const cubc = [
    { value: 50, currency: 'USD' }, { value: 10, currency: 'USD' },
    { value: 50000, currency: 'KHR' }, { value: 100, currency: 'USD' },
  ];
  assert.strictEqual(breakdown(190, cubc, { currency: 'USD', slots: 8 }).fieldG, '0104000100000000');
});
