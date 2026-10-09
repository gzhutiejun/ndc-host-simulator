const test = require('node:test');
const assert = require('node:assert');
const makeDdcInterbank = require('../src/handlers/ddcInterbank');
const { parse } = require('../src/ndc/parser');
const { encodeText } = require('../src/framing');
const { FS } = require('../src/constants');
const { createSession } = require('../src/session');

// 序列照 Diebold trace（acc-cubc docs/cubc/reference/diebold-logs/df-interbank-raw.txt）。
function req(opcode, { amount = '000000000000', b = '', c = '' } = {}) {
  return parse(encodeText([
    '11', 'CUB', '', '', '17', ';91160800000003463=XXXX?', '',
    opcode, amount, ':;<=>?12', b, c,
  ].join(FS)));
}
const helpers = { now: () => new Date(Date.UTC(2026, 9, 8, 10, 0)) };

test('本行 NBC 卡：DF A 账户列表（屏 047）→ 回送行号 → 808', () => {
  const h = makeDdcInterbank({});
  const s = createSession();
  const a = h(req('DF AAD  '), s, helpers).split(FS);
  assert.deepStrictEqual([a[0], a[3]], ['3', '210110010000']);
  assert.ok(a[5].includes('\x1bO047'));
  assert.strictEqual(h(req('DF AAD  ', { b: 'I' }), s, helpers).split(FS)[3], '808');
  assert.strictEqual(h(req('DF AAD  ', { b: 'E' }), s, helpers).split(FS)[3], '131');
});

test('DF B → 814、DF C → 861、DF D → 820、DF F → 209、C → 822、DF G → 130 带凭条', () => {
  const h = makeDdcInterbank({ banks: { '089': 'AMK MICROFINANCE' } });
  const s = createSession();
  assert.strictEqual(h(req('DFFBAB  ', { c: '089' }), s, helpers).split(FS)[3], '814');
  assert.strictEqual(h(req('DFFCAB  ', { c: '0011234567118' }), s, helpers).split(FS)[3], '861');
  assert.strictEqual(h(req('DFFDABC ', { amount: '000000200000', c: '0011234567118' }), s, helpers).split(FS)[3], '820');
  const f = h(req('DFFFABC ', { amount: '000000200000', c: '0011234567118' }), s, helpers).split(FS);
  assert.deepStrictEqual([f[0], f[3]], ['3', '210001110000']);
  assert.ok(f[5].includes('FA BENEFICIARY:AMK MICROFINANCE'));
  assert.ok(f[5].includes('IA AMOUNT     :2,000.00 KHR'));
  assert.ok(f[5].includes('JA FEE CHARGE :2400.00 KHR'));
  assert.strictEqual(h(req('DFFFABC ', { b: 'C' }), s, helpers).split(FS)[3], '822');
  const g = h(req('DFFGABC ', { amount: '000000200000', c: '0011234567118' }), s, helpers).split(FS);
  assert.strictEqual(g[3], '130');
  assert.ok(g[6].includes('FUNDS TRANSFER'));
  assert.ok(g[6].includes('AMK MICROFINANCE'));
});

test('确认屏 NO（D）→ 131；收款账号无效 → G 段 149', () => {
  const h = makeDdcInterbank({ invalidAccount: '0110000000999' });
  assert.strictEqual(h(req('DF FABC ', { b: 'D' }), createSession(), helpers).split(FS)[3], '131');
  assert.strictEqual(h(req('DF GABC ', { c: '0110000000999' }), createSession(), helpers).split(FS)[3], '149');
});
