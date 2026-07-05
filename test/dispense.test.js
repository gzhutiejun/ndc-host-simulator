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
