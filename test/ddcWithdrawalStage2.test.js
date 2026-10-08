const test = require('node:test');
const assert = require('node:assert');
const makeDdcWithdrawalStage2 = require('../src/handlers/ddcWithdrawalStage2');
const { parse } = require('../src/ndc/parser');
const { encodeText } = require('../src/framing');
const { FS } = require('../src/constants');
const { createSession } = require('../src/session');

// 形状取自现网真实报文：操作码基码 "AA C"，金额是 12 位、后 2 位是分（"000000020000"=200.00）。
function stage2Req(amount = '000000020000', opcode = 'AA CAAC ') {
  return parse(encodeText([
    '11', 'CUB', '', '', '17', ';461760XXXXXX7710=XXXXXXXXXXXXXXXXXXXX?', '',
    opcode, amount,
  ].join(FS)));
}
const helpers = { applyTemplate: (s) => s, ctx: {}, constants: require('../src/constants'), now: () => new Date() };

test('approves stage 2: class 4, next-state 128, fieldG dispenses the amount', () => {
  const handler = makeDdcWithdrawalStage2({ cassettes: [50, 100, 500, 1000] });
  const out = handler(stage2Req('000000020000'), createSession(), helpers); // 200.00
  const f = out.split(FS);
  assert.strictEqual(f[0], '4');
  assert.strictEqual(f[1], 'CUB');
  assert.strictEqual(f[3], '128');
  assert.strictEqual(f[4], '00020000'); // greedy: 2x100
});

test('12 位金额字段按分定位小数点（末两位是分）', () => {
  const handler = makeDdcWithdrawalStage2({ cassettes: [1] });
  const out = handler(stage2Req('000000000500'), createSession(), helpers); // 5.00 -> 5 元
  assert.strictEqual(out.split(FS)[4], String(5).padStart(2, '0'));
});

test('non-dispensable amount → decline reply (empty fieldG)', () => {
  const handler = makeDdcWithdrawalStage2({ cassettes: [50, 100] });
  const out = handler(stage2Req('000000000700'), createSession(), helpers); // 7.00 元，凑不出来
  const f = out.split(FS);
  assert.strictEqual(f[4], '');
});

test('declines when amount exceeds maxAmount', () => {
  const handler = makeDdcWithdrawalStage2({ cassettes: [50], maxAmount: 100 });
  const out = handler(stage2Req('000000015000'), createSession(), helpers); // 150 元 > 100
  const f = out.split(FS);
  assert.strictEqual(f[4], '');
  assert.notStrictEqual(f[3], '128'); // 不是批准的 next-state
});

test('decline next-state is configurable, defaults away from the approved one', () => {
  const handler = makeDdcWithdrawalStage2({ cassettes: [50], maxAmount: 100, declineNextState: '140' });
  const out = handler(stage2Req('000000015000'), createSession(), helpers);
  assert.strictEqual(out.split(FS)[3], '140');
});

// includeCam：跟标准 NDC 的 withdrawal 块同一条纪律——只在批准的应答上追加
// （被拒绝的这一笔本来就没有走完 EMV 密文交换），出厂默认关闭。
test('includeCam appends the EMV boundary segment on approval only', () => {
  const on = makeDdcWithdrawalStage2({ cassettes: [50, 100], includeCam: true, camArc: '00' });
  const approved = on(stage2Req('000000020000'), createSession(), helpers);
  const af = approved.split(FS);
  assert.strictEqual(af.length, 8);
  assert.strictEqual(af[7], "'9''M'3030");

  const declined = on(stage2Req('000000000700'), createSession(), helpers); // 凑不出来
  assert.strictEqual(declined.split(FS).length, 7); // 拒绝这条不带 EMV 段
});

const CUBC_CASSETTES = [
  { value: 50, currency: 'USD' }, { value: 10, currency: 'USD' },
  { value: 50000, currency: 'KHR' }, { value: 100, currency: 'USD' },
];

test('CUBC 钞箱：币种取操作码位 6（A=USD、B=KHR），出钞字段 8 组', () => {
  const handler = makeDdcWithdrawalStage2({ cassettes: CUBC_CASSETTES, fieldGCassettes: 8 });
  const usd = handler(stage2Req('000000019000', 'AA CAAC '), createSession(), helpers).split(FS);
  assert.strictEqual(usd[3], '128');
  assert.strictEqual(usd[4], '0104000100000000');
  const khr = handler(stage2Req('000010000000', 'AA CABC '), createSession(), helpers).split(FS);
  assert.strictEqual(khr[4], '0000020000000000');
});

test('没配屏幕模板时按现网形状回 Z000930 / Z000929 / Z000931（余额、本笔金额），凭条可用 <BALANCE>', () => {
  const handler = makeDdcWithdrawalStage2({
    cassettes: CUBC_CASSETTES, fieldGCassettes: 8, balance: '485.56',
    receipt: { printerData: '2 TRANS AMOUNT  : <AMOUNT> USD<LF> BALANCE       : <BALANCE>USD' },
  });
  const f = handler(stage2Req('000000019000', 'AA CAAC '), createSession(), helpers).split(FS);
  assert.match(f[5], /;\x1dZ000930485\.56 USD\x1dZ000929190\.00 USD\x1dZ000931485\.56 USD$/);
  assert.match(f[6], /TRANS AMOUNT {2}: 190\.00 USD\n BALANCE {7}: 485\.56USD/);
});
