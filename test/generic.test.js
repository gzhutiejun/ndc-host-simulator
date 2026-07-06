const test = require('node:test');
const assert = require('node:assert');
const makeGeneric = require('../src/handlers/generic');
const { parse } = require('../src/ndc/parser');
const { encodeText } = require('../src/framing');
const { FS } = require('../src/constants');
const { createSession } = require('../src/session');

function txnReq(opcode = 'D       ', amount = '') {
  return parse(encodeText(['11', '000', '', '', '15', ';XXXX=XXXX?', '', opcode, amount].join(FS)));
}
const helpers = {
  applyTemplate: (s) => s,
  ctx: {},
  constants: require('../src/constants'),
  now: () => new Date('2026-06-02T09:52:00Z'),
};

test('generic fallback: class 4, next-state 048, empty fieldG, always a reply', () => {
  const handler = makeGeneric({});
  const out = handler(txnReq('D       '), createSession(), helpers);
  assert.notStrictEqual(out, null);
  const f = out.split(FS);
  assert.strictEqual(f[0], '4');
  assert.strictEqual(f[3], '048'); // safe cancel next-state
  assert.strictEqual(f[4], '');    // no dispense
});

test('generic fallback: no CAM by default (7 fields)', () => {
  const handler = makeGeneric({});
  const out = handler(txnReq('I       '), createSession(), helpers);
  assert.strictEqual(out.split(FS).length, 7);
});

test('generic fallback: never returns null even with empty opcode and no amount', () => {
  const handler = makeGeneric({});
  const out = handler(txnReq('', ''), createSession(), helpers);
  assert.notStrictEqual(out, null);
  assert.strictEqual(out.split(FS)[0], '4');
});

test('generic fallback: nextState is configurable', () => {
  const handler = makeGeneric({ nextState: '138' });
  const out = handler(txnReq('D       '), createSession(), helpers);
  assert.strictEqual(out.split(FS)[3], '138');
});

test('generic fallback: printer block echoes MCN + return-card + flag and renders template', () => {
  const handler = makeGeneric({ returnCard: '0', printerFlag: '1', receipt: { printerData: 'CANCELLED <RECNO>' } });
  const out = handler(txnReq('D       '), createSession(), helpers);
  const printer = out.split(FS)[6];
  assert.strictEqual(printer.slice(0, 3), '501'); // MCN '5' (field[4]='15') + '0' + '1'
  assert.ok(printer.includes('CANCELLED 1')); // first nextTvn() → recno 1
});
