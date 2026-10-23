const test = require('node:test');
const assert = require('node:assert');
const { parseSupplyCountersStatus } = require('../src/ndc/supplyCounters');
const { GS } = require('../src/constants');

const EXT = '7A00120001234' + GS + 'B00003' + GS
  + 'C0010050000012002000000200000002010000000000040000000000000300000000000000000000000000040000000000000000000000000' + GS
  + 'I' + GS + 'J100045200003' + GS + 'K00004000070023000000';

test('扩展：设计 6.1 的例子逐字段', () => {
  const r = parseSupplyCountersStatus(EXT);
  assert.strictEqual(r.kind, 'extended');
  assert.deepStrictEqual(r.groups.A, { tsn: '0012', accumulated: 1234 });
  assert.strictEqual(r.groups.B.captured, 3);
  assert.strictEqual(r.groups.C.types.length, 4);
  assert.deepStrictEqual(r.groups.C.types[0], { type: 1, notes: 500, rejected: 12, dispensed: 200, last: 2, deposited: 0 });
  assert.deepStrictEqual(r.groups.C.types[1], { type: 2, notes: 1000, rejected: 0, dispensed: 40, last: 0, deposited: 0 });
  assert.deepStrictEqual(r.groups.I.cassettes, []);
  assert.deepStrictEqual(r.groups.J.bins, [{ bin: 1, count: 45 }, { bin: 2, count: 3 }]);
  assert.deepStrictEqual(r.groups.K, { refunded: 4, rejected: 7, encashed: 230, escrowed: 0 });
  assert.strictEqual(r.trailingGs, false);
  assert.deepStrictEqual(r.errors, []);
  assert.deepStrictEqual(r.unknownGroups, []);
});

test('扩展：7 类型 C 组', () => {
  const slot = (t) => String(t).padStart(3, '0') + '00000'.repeat(5);
  const r = parseSupplyCountersStatus('7A00010000001' + GS + 'C' + [1, 2, 3, 4, 5, 6, 7].map(slot).join(''));
  assert.strictEqual(r.groups.C.types.length, 7);
  assert.strictEqual(r.groups.C.types[6].type, 7);
  assert.deepStrictEqual(r.errors, []);
});

test('扩展：I 组一个单元两种钞种', () => {
  const r = parseSupplyCountersStatus('7A00010000001' + GS + 'I00100230002000100200000200030');
  assert.deepStrictEqual(r.groups.I.cassettes, [{ type: 1, notes: 230, noteTypes: [{ id: 1, count: 200 }, { id: 2, count: 30 }] }]);
  assert.deepStrictEqual(r.errors, []);
});

test('扩展：C 组体长 27 -> errors；末尾 GS -> trailingGs', () => {
  const bad = parseSupplyCountersStatus('7A00010000001' + GS + 'C' + '0'.repeat(27));
  assert.ok(bad.errors.length > 0);
  assert.strictEqual(bad.groups.C, undefined);
  const t = parseSupplyCountersStatus('7A00010000001' + GS);
  assert.strictEqual(t.trailingGs, true);
  assert.strictEqual(t.groups.A.accumulated, 1);
  const u = parseSupplyCountersStatus('7A00010000001' + GS + 'Z123');
  assert.deepStrictEqual(u.unknownGroups, ['Z']);
});

test('基本格式 112 位按字段主序解码（四类型箱内 / 拒钞 / 已付 / 上笔依次排列），111 位与非数字报错', () => {
  const c = (n) => String(n).padStart(5, '0');
  // 应用 buildSupplyCountersStatusInfo：g4 四类型箱内、g5 四类型拒钞、g6 四类型已付、g7 四类型上笔，再 g8..g11
  const notes = [500, 1000, 0, 7];
  const rejected = [12, 0, 0, 8];
  const dispensed = [200, 40, 0, 9];
  const last = [2, 0, 0, 6];
  const info = '2' + '0012' + '0001234'
    + [notes, rejected, dispensed, last].map((a) => a.map(c).join('')).join('')
    + c(3) + c(4) + c(5) + c(6);
  assert.strictEqual(info.length, 112);
  const r = parseSupplyCountersStatus(info);
  assert.strictEqual(r.kind, 'basic');
  assert.strictEqual(r.tsn, '0012');
  assert.strictEqual(r.accumulated, 1234);
  assert.deepStrictEqual(r.cassettes[0], { notes: 500, rejected: 12, dispensed: 200, last: 2 });
  assert.deepStrictEqual(r.cassettes[1], { notes: 1000, rejected: 0, dispensed: 40, last: 0 });
  assert.deepStrictEqual(r.cassettes[3], { notes: 7, rejected: 8, dispensed: 9, last: 6 });
  assert.deepStrictEqual([r.cardsCaptured, r.envelopes, r.camera, r.lastEnvelope], [3, 4, 5, 6]);
  const short = parseSupplyCountersStatus(info.slice(0, 111));
  assert.strictEqual(short.kind, 'basic');
  assert.ok(short.error);
  assert.ok(parseSupplyCountersStatus(info.slice(0, 50) + 'x' + info.slice(51)).error);
});

test('扩展：非数字计数字段进 errors，不产生 NaN', () => {
  const r = parseSupplyCountersStatus('7A0012000123x' + GS + 'B0000y');
  assert.ok(r.errors.length >= 2);
  assert.strictEqual(Number.isNaN(r.groups.A.accumulated), false);
  assert.strictEqual(Number.isNaN(r.groups.B.captured), false);
});

test('非供应计数首字符 -> undefined', () => {
  assert.strictEqual(parseSupplyCountersStatus('9'), undefined);
});
