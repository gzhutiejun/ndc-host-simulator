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
  assert.match(out.split(FS)[6], /^REC 1 /);
});
