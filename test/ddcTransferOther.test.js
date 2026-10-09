const test = require('node:test');
const assert = require('node:assert');
const makeDdcTransferOther = require('../src/handlers/ddcTransferOther');
const { parse } = require('../src/ndc/parser');
const { encodeText } = require('../src/framing');
const { FS, GS } = require('../src/constants');
const { createSession } = require('../src/session');

// 请求段位与 acc-cubc 的 build-transaction-request.ts 一致：[7] 操作码 [8] 金额 [9] PIN [10] Buffer B [11] Buffer C。
function req(opcode, { amount = '000000000258', b = '', c = '' } = {}) {
  return parse(encodeText([
    '11', 'CUB', '', '', '17', ';422131XXXXXX7329=XXXXXXXXXXXXXXXXXXXX?', '',
    opcode, amount, ':;<=>?12', b, c,
  ].join(FS)));
}
const helpers = { applyTemplate: (s) => s, ctx: {}, constants: require('../src/constants'), now: () => new Date(Date.UTC(2026, 9, 7, 10, 0)) };
const run = (cfg, request) => makeDdcTransferOther(cfg)(request, createSession(), helpers).split(FS);

test('GD F，Buffer B 空：回账户列表 ITR（SIM:182 的形状）', () => {
  const f = run({}, req('GD FA C ', { amount: '000000000000' }));
  assert.strictEqual(f[0], '3');
  assert.strictEqual(f[3], '210110010000');
  assert.strictEqual(f[4], '037');
  assert.strictEqual(f[5], '\x0c\x0c\x1bO047\x1bP0470\x1bH000\x0f@TOAR\x0fI1       0112***80 USD-->\x0fL1       0111***61 USD-->');
});

test('GD F，Buffer B = 账户键：回 430', () => {
  const f = run({}, req('GD FA C ', { amount: '000000000000', b: 'B' }));
  assert.strictEqual(f[0], '4');
  assert.strictEqual(f[3], '430');
});

test('singleAccount：GD F 直接回 430（NOITR:183）', () => {
  assert.strictEqual(run({ singleAccount: true }, req('GD FA C ', { amount: '000000000000' }))[3], '430');
});

test('GD G：回 434，screen = TSN + Z000964/962/963 + 5025（SIM:188）', () => {
  const f = run({}, req('GD GA C ', { b: '01110110281087' }));
  assert.strictEqual(f[3], '434');
  const parts = f[5].split(GS);
  assert.match(parts[0], /^\d{4}Z0009642\.58 USD$/);
  assert.deepStrictEqual(parts.slice(1), ['Z00096201110110281087', 'Z000963##TITLE 1##011101102', '5025']);
});

test('GD G，目标账号 = invalidAccount：回 149', () => {
  assert.strictEqual(run({ invalidAccount: '01110110999999' }, req('GD GA C ', { b: '01110110999999' }))[3], '149');
});

test('GD H，Buffer B = 目标账号：回确认 ITR 屏 209（SIM:193）', () => {
  const f = run({}, req('GD HA C ', { b: '01110110281087' }));
  assert.strictEqual(f[0], '3');
  assert.strictEqual(f[3], '210001110000');
  assert.strictEqual(f[5], '\x0c\x0c\x1bO209\x1bP2090\x1bH000\x0fHM 01120110044380\x0fJM 2.58 USD\x0fLM 01110110281087  ');
});

test('GD H，Buffer B = C：回 130 带 FUNDS TRANSFER 凭条', () => {
  const f = run({}, req('GD HA C ', { b: 'C' }));
  assert.strictEqual(f[3], '130');
  assert.ok(f[6].startsWith('002'), f[6]);
  assert.ok(f[6].includes('FUNDS TRANSFER'));
  assert.ok(f[6].includes('2.58 USD'));
});

test('GD H，Buffer B = C 且超 limitCents：回 162', () => {
  assert.strictEqual(run({ limitCents: 100 }, req('GD HA C ', { b: 'C' }))[3], '162');
});

test('GD H，Buffer B = D：回 declineNextState（缺省 131）', () => {
  assert.strictEqual(run({}, req('GD HA C ', { b: 'D' }))[3], '131');
});

test('不是 GD F/G/H 时返回 null，交给后面的规则', () => {
  assert.strictEqual(makeDdcTransferOther({})(req('GD BA CC'), createSession(), helpers), null);
});
