const test = require('node:test');
const assert = require('node:assert');
const makeDdcCardPayment = require('../src/handlers/ddcCardPayment');
const { parse } = require('../src/ndc/parser');
const { encodeText } = require('../src/framing');
const { FS, GS } = require('../src/constants');
const { createSession } = require('../src/session');

function req(opcode, { amount = '000000000658', b = '', c = '' } = {}) {
  return parse(encodeText([
    '11', 'CUB', '', '', '17', ';911608XXXXXXX4804=XXXXXXXXXXXXXXXXXXXX?', '',
    opcode, amount, ':;<=>?12', b, c,
  ].join(FS)));
}
const helpers = { applyTemplate: (s) => s, ctx: {}, constants: require('../src/constants'), now: () => new Date(Date.UTC(2026, 9, 7, 10, 0)) };
const run = (cfg, request) => makeDdcCardPayment(cfg)(request, createSession(), helpers).split(FS);
const CARD = '4043188686581509';

test('FG A，Buffer B 空：账户列表 ITR（SIM:215 与 SIM:182 相同）', () => {
  const f = run({}, req('FG AA C ', { amount: '000000000000' }));
  assert.strictEqual(f[0], '3');
  assert.ok(f[5].includes('\x0fI1       0112***80 USD-->'));
});

test('FG A，选了账户或单账户：382', () => {
  assert.strictEqual(run({}, req('FG AA C ', { amount: '000000000000', b: 'A' }))[3], '382');
  assert.strictEqual(run({ singleAccount: true }, req('FG AA C ', { amount: '000000000000' }))[3], '382');
});

test('FG B：385，Z000965 = Buffer C 的卡号、Z000963 持卡人（SIM:221）', () => {
  const f = run({}, req('FG BA C ', { amount: '000000000000', c: CARD }));
  assert.strictEqual(f[3], '385');
  assert.deepStrictEqual(f[5].split(GS).slice(0, 2).map((p) => p.replace(/^\d{4}/, '')),
    [`Z000965${CARD}`, 'Z000963PHASE2-001 SV']);
});

test('FG B，卡号 = invalidCard：149', () => {
  assert.strictEqual(run({ invalidCard: CARD }, req('FG BA C ', { amount: '000000000000', c: CARD }))[3], '149');
});

test('FG C：390，五个 Z 字段（SIM:226 的顺序）', () => {
  const f = run({}, req('FG CA C ', { c: CARD }));
  assert.strictEqual(f[3], '390');
  const parts = f[5].split(GS);
  assert.match(parts[0], /^\d{4}Z0009646\.58 USD$/);
  assert.deepStrictEqual(parts.slice(1), [
    `Z000965${CARD}`, 'Z0009330.00 USD', 'Z00096201110110344901 USD', 'Z000963PHASE2-001 SV', '5025',
  ]);
});

test('FG C 超 limitCents：162', () => {
  assert.strictEqual(run({ limitCents: 500 }, req('FG CA C ', { c: CARD }))[3], '162');
});

test('FG D：130 带 CREDIT PAYMENT 凭条，卡号掩码', () => {
  const f = run({}, req('FG DA C ', { c: CARD }));
  assert.strictEqual(f[3], '130');
  assert.ok(f[6].includes('CREDIT PAYMENT'));
  assert.ok(f[6].includes('XXXXXXXXXXXX1509'));
  assert.ok(!f[6].includes(CARD));
});
