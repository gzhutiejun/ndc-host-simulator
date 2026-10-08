const test = require('node:test');
const assert = require('node:assert');
const makeDdcBalanceStage2 = require('../src/handlers/ddcBalanceStage2');
const { parse } = require('../src/ndc/parser');
const { encodeText } = require('../src/framing');
const { FS } = require('../src/constants');
const { createSession } = require('../src/session');

function stage2Req(opcode = 'BA BAC ') {
  return parse(encodeText([
    '11', 'CUB', '', '', '18', ';461760XXXXXX7710=XXXXXXXXXXXXXXXXXXXX?', '',
    opcode, '',
  ].join(FS)));
}
const helpers = { applyTemplate: (s) => s, ctx: {}, constants: require('../src/constants'), now: () => new Date() };

test('approves stage 2: class 4, next-state 063, empty fieldG, balance in screen', () => {
  const handler = makeDdcBalanceStage2({ amount: '5000.00', receipt: { screen: 'BAL <BALANCE>', printerData: '' } });
  const out = handler(stage2Req(), createSession(), helpers);
  const f = out.split(FS);
  assert.strictEqual(f[0], '4');
  assert.strictEqual(f[1], 'CUB');
  assert.strictEqual(f[3], '063');
  assert.strictEqual(f[4], '');            // 余额查询不出钞
  assert.strictEqual(f[5], 'BAL 5000.00');
});

test('next-state and balance amount are configurable', () => {
  const handler = makeDdcBalanceStage2({ nextState: '140', amount: '12.34', receipt: { screen: '<BALANCE>' } });
  const out = handler(stage2Req(), createSession(), helpers);
  const f = out.split(FS);
  assert.strictEqual(f[3], '140');
  assert.strictEqual(f[5], '12.34');
});

test('printer template substitutes recno/date/time/pan', () => {
  const handler = makeDdcBalanceStage2({ receipt: { printerData: 'REC <RECNO> <PAN>' } });
  const out = handler(stage2Req(), createSession(), helpers);
  // 打印字段头 2 字节（o+p，值本身不读，只占位，见 receipt.js 的 DDC_PRINT_HEADER_PAD）
  // + 模板内容——不是模板内容从位 0 开始。
  assert.match(out.split(FS)[6], /^00REC 1 /);
});

test('没配屏幕模板时按现网形状回 Z000930（可用）/ Z000931（账面），带千分位与币种', () => {
  const handler = makeDdcBalanceStage2({ amount: '1266.89', ledgerAmount: '1271.89' });
  const f = handler(stage2Req(), createSession(), helpers).split(FS);
  assert.strictEqual(f[5], '0001;\x1dZ0009301,266.89 USD\x1dZ0009311,271.89 USD\x1d5025');
});

test('账面余额缺省同可用余额', () => {
  const handler = makeDdcBalanceStage2({ amount: '13.96' });
  assert.match(handler(stage2Req(), createSession(), helpers).split(FS)[5], /Z00093013\.96 USD\x1dZ00093113\.96 USD/);
});

test('凭条占位符：<CARD> 是掩码卡号（现网 461760XXXXXX7710），<LEDGER> 是账面余额，<CCY> 是币种', () => {
  const handler = makeDdcBalanceStage2({
    amount: '1,266.89', ledgerAmount: '1,271.89',
    receipt: { printerData: '2 CARD NO : <CARD><LF> <BALANCE> <CCY><LF> <LEDGER> <CCY>' },
  });
  const req = parse(encodeText(['11', 'CUB', '', '', '18', ';4617601234567710=25121011000000000?', '', 'BA BAC ', ''].join(FS)));
  const f = handler(req, createSession(), helpers).split(FS);
  assert.strictEqual(f[6], '002 CARD NO : 461760XXXXXX7710\n 1,266.89 USD\n 1,271.89 USD');
});
