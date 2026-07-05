const test = require('node:test');
const assert = require('node:assert');
const C = require('../src/constants');

test('control characters have exact byte values', () => {
  assert.strictEqual(C.FS.charCodeAt(0), 0x1c);
  assert.strictEqual(C.GS.charCodeAt(0), 0x1d);
  assert.strictEqual(C.RS.charCodeAt(0), 0x1e);
  assert.strictEqual(C.ETX.charCodeAt(0), 0x03);
  assert.strictEqual(C.SO.charCodeAt(0), 0x0e);
  assert.strictEqual(C.SI.charCodeAt(0), 0x0f);
});

test('class and status tables map known codes', () => {
  assert.strictEqual(C.T2C_CLASS['2'], 'SolicitedStatus');
  assert.strictEqual(C.C2T_CLASS['4'], 'TransactionReply');
  assert.strictEqual(C.SUBCLASS['1'], 'TransactionRequest');
  assert.strictEqual(C.STATUS_DESCRIPTOR.READY_B, 'B');
});
