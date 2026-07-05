const test = require('node:test');
const assert = require('node:assert');
const makeBalance = require('../src/handlers/balance');
const { parse } = require('../src/ndc/parser');
const { encodeText } = require('../src/framing');
const { FS } = require('../src/constants');
const { createSession } = require('../src/session');

function balanceReq(opcode = 'CC   C  ') {
  return parse(encodeText(['11', '000', '', '', '15', ';XXXX=XXXX?', '', opcode, ''].join(FS)));
}
const helpers = {
  applyTemplate: (s) => s,
  ctx: {},
  constants: require('../src/constants'),
  now: () => new Date('2026-06-02T09:52:00Z'),
};

test('balance inquiry: class 4, next-state 074, empty fieldG, balance in screen', () => {
  const handler = makeBalance({ nextState: '074', amount: '5000.00', receipt: { screen: 'BAL <BALANCE>', printerData: '' } });
  const out = handler(balanceReq(), createSession(), helpers);
  const f = out.split(FS);
  assert.strictEqual(f[0], '4');
  assert.strictEqual(f[3], '074');
  assert.strictEqual(f[4], '');            // no dispense
  assert.strictEqual(f[5], 'BAL 5000.00'); // balance rendered into screen
});

test('printer block echoes MCN + return-card + flag', () => {
  const handler = makeBalance({ returnCard: '0', printerFlag: '1', receipt: { printerData: 'RCPT' } });
  const out = handler(balanceReq(), createSession(), helpers);
  const printer = out.split(FS)[6];
  assert.strictEqual(printer.slice(0, 3), '501'); // MCN '5' (field[4]='15') + '0' + '1'
});

test('no CAM by default (7 fields)', () => {
  const handler = makeBalance({});
  const out = handler(balanceReq(), createSession(), helpers);
  assert.strictEqual(out.split(FS).length, 7);
});
