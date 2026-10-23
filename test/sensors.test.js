const test = require('node:test');
const assert = require('node:assert');
const { parseSensorsStatus, parseTamperSensorStatus } = require('../src/ndc/sensors');

test('P3001000111111：门开、卡仓 / 废钞箱 / 四箱在', () => {
  const r = parseSensorsStatus('P3001000111111');
  assert.strictEqual(r.kind, 'alarm');
  assert.strictEqual(r.door, true);
  assert.strictEqual(r.supervisor, false);
  assert.strictEqual(r.vibrationHeat, false);
  assert.strictEqual(r.silentSignal, false);
  assert.strictEqual(r.enclosure, false);
  assert.strictEqual(r.depositBin, false);
  assert.strictEqual(r.cardBin, true);
  assert.strictEqual(r.rejectBin, true);
  assert.deepStrictEqual(r.cassettes, [true, true, true, true]);
  assert.strictEqual(r.extra, '');
  assert.deepStrictEqual(r.errors, []);
});

test('P1101000110111：TI、supervisor、1 号箱抽出', () => {
  const r = parseSensorsStatus('P1101000110111');
  assert.strictEqual(r.kind, 'ti');
  assert.strictEqual(r.supervisor, true);
  assert.strictEqual(r.door, true);
  assert.deepStrictEqual(r.cassettes, [false, true, true, true]);
});

test('防撬 / 振动 / 关门', () => {
  assert.strictEqual(parseSensorsStatus('P3000010111111').enclosure, true);
  assert.strictEqual(parseSensorsStatus('P3010000111111').vibrationHeat, true);
  assert.strictEqual(parseSensorsStatus('P3000000111111').door, false);
  assert.strictEqual(parseSensorsStatus('P3000100111111').silentSignal, true);
});

test('类型 5 / 6 与字节 14 以后的原文', () => {
  assert.strictEqual(parseSensorsStatus('P5000000111111').kind, 'full');
  const r = parseSensorsStatus('P6000000111111XY');
  assert.strictEqual(r.kind, 'flexible');
  assert.strictEqual(r.extra, 'XY');
});

test('P21 / P20 / P211', () => {
  assert.deepStrictEqual(parseSensorsStatus('P21'), { kind: 'mode', entered: true, aer: false, errors: [] });
  assert.strictEqual(parseSensorsStatus('P20').entered, false);
  assert.strictEqual(parseSensorsStatus('P211').aer, true);
});

test('坏输入报错', () => {
  assert.ok(parseSensorsStatus('P300100011111').errors.length > 0);
  assert.ok(parseSensorsStatus('P30010001111X1').errors.length > 0);
  assert.ok(parseSensorsStatus('Q3001000111111').errors.length > 0);
  assert.ok(parseSensorsStatus('P9001000111111').errors.length > 0);
});

test('parseTamperSensorStatus：全静', () => {
  const r = parseTamperSensorStatus(['KA00000', 'B0111111000000']);
  assert.deepStrictEqual(r.errors, []);
  assert.deepStrictEqual(r.a, { supervisor: false, vibrationHeat: false, door: false, silentSignal: false, enclosure: false });
  assert.strictEqual(r.b.depositBin, false);
  assert.strictEqual(r.b.cardBin, true);
  assert.strictEqual(r.b.rejectBin, true);
  assert.deepStrictEqual(r.b.cassettes, [true, true, true, true]);
  assert.strictEqual(r.b.coinDispenser, false);
  assert.deepStrictEqual(r.b.hoppers, [false, false, false, false]);
  assert.strictEqual(r.b.reserved, false);
  assert.strictEqual(r.c, undefined);
});

test('parseTamperSensorStatus：supervisor + 门开；C 段原文；坏格式', () => {
  const r = parseTamperSensorStatus(['KA10100', 'B0111111000000', 'C12']);
  assert.strictEqual(r.a.supervisor, true);
  assert.strictEqual(r.a.door, true);
  assert.strictEqual(r.c, 'C12');
  assert.ok(parseTamperSensorStatus(['KA00000']).errors.length > 0);
  assert.ok(parseTamperSensorStatus(['KA0000', 'B0111111000000']).errors.length > 0);
});
