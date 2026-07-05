const test = require('node:test');
const assert = require('node:assert');
const makeWithdrawal = require('../src/handlers/withdrawal');
const { parse } = require('../src/ndc/parser');
const { encodeText } = require('../src/framing');
const { FS, SO } = require('../src/constants');
const { createSession } = require('../src/session');

function withdrawalReq(amount = '00000300') {
  return parse(encodeText(['11', '000', '', '', '15', ';XXXX=XXXX?', '', 'ADC     ', amount].join(FS)));
}
const helpers = {
  applyTemplate: (s) => s,
  ctx: {},
  constants: require('../src/constants'),
  now: () => new Date('2026-07-05T09:52:00Z'),
};

test('approves a withdrawal: class 4, next-state 123, fieldG for amount', () => {
  const handler = makeWithdrawal({ cassettes: [50, 100, 500, 1000], approvedNextState: '123' });
  const out = handler(withdrawalReq('00000300'), createSession(), helpers);
  const f = out.split(FS);
  assert.strictEqual(f[0], '4');
  assert.strictEqual(f[1], '000');
  assert.strictEqual(f[3], '123');
  assert.strictEqual(f[4], '00030000'); // greedy 3x100
});

test('printer block starts with echoed MCN + return-card flag', () => {
  const handler = makeWithdrawal({ returnCard: '0', receipt: { printerData: 'RCPT' } });
  const out = handler(withdrawalReq('00000300'), createSession(), helpers);
  const printer = out.split(FS)[6];
  assert.strictEqual(printer[0], '5'); // MCN echoed from request field[4]='15'
  assert.strictEqual(printer[1], '0'); // return card
});

test('receipt template substitutes amount and control chars', () => {
  const handler = makeWithdrawal({ receipt: { printerData: 'AED <AMOUNT><LF>NO:<SO><RECNO>' } });
  const out = handler(withdrawalReq('00000300'), createSession(), helpers);
  const printer = out.split(FS)[6];
  assert.ok(printer.includes('AED 300.00'));
  assert.ok(printer.includes('\n')); // <LF> → 0x0A
  assert.ok(printer.includes(SO)); // <SO> → 0x0E
});

test('non-dispensable amount → null (decline hook)', () => {
  const handler = makeWithdrawal({ cassettes: [50, 100, 500, 1000] });
  const out = handler(withdrawalReq('00000030'), createSession(), helpers); // 30 not dispensable
  assert.strictEqual(out, null);
});

test('includeCam appends a CAM buffer with ARC', () => {
  const handler = makeWithdrawal({ includeCam: true, camArc: '00' });
  const out = handler(withdrawalReq('00000300'), createSession(), helpers);
  const f = out.split(FS);
  assert.strictEqual(f.length, 8); // …+cam
  assert.ok(f[7].startsWith('5CAM'));
  assert.ok(f[7].endsWith('3030')); // ARC '00' → hex 3030
});

test('shipped config.json receipt template renders without FS corruption and substitutes amount', () => {
  const cfg = JSON.parse(require('node:fs').readFileSync(require('node:path').join(__dirname, '..', 'config.json'), 'utf8')).withdrawal;
  const handler = makeWithdrawal(cfg);
  const out = handler(withdrawalReq('00000300'), createSession(), helpers);
  assert.strictEqual(out.split(FS)[0], '4');
  const printer = out.split(FS)[6];
  assert.ok(printer.includes('CASH WITHDRAWAL'));
  assert.ok(printer.includes('AED 300.00'));
});
