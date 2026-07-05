const test = require('node:test');
const assert = require('node:assert');
const { buildTransactionReply } = require('../src/ndc/transactionReply');
const { FS } = require('../src/constants');

test('builds a minimal transaction reply without CAM', () => {
  const out = buildTransactionReply({
    luno: '000', nextState: '123', fieldG: '00030000',
    screen: 'SCR', printer: '501RCPT',
  });
  assert.strictEqual(out, ['4', '000', '', '123', '00030000', 'SCR', '501RCPT'].join(FS));
});

test('appends CAM field when provided', () => {
  const out = buildTransactionReply({
    luno: '000', nextState: '123', fieldG: '00030000',
    screen: 'SCR', printer: '501RCPT', cam: '5CAM8A023030',
  });
  assert.strictEqual(
    out,
    ['4', '000', '', '123', '00030000', 'SCR', '501RCPT', '5CAM8A023030'].join(FS)
  );
});

test('honours explicit stn', () => {
  const out = buildTransactionReply({ luno: '000', stn: '7', nextState: '123', fieldG: '01000000' });
  assert.strictEqual(out, ['4', '000', '7', '123', '01000000', '', ''].join(FS));
});
