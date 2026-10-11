const test = require('node:test');
const assert = require('node:assert');
const makeDdcDeviceFaultReply = require('../src/handlers/ddcDeviceFaultReply');
const { FS } = require('../src/constants');

const session = { tvn: 8470 };
const fault = (status) => ({ messageClass: '2', fields: ['22', 'CUB', '', '8', status] });

test('Diebold 12:40:54: no notes out → 142 NO NOTES DISPENSED (journal only)', () => {
  const r = makeDdcDeviceFaultReply()(fault('?51751b00000002a00000003@00000004@0000000'), session).split(FS);
  assert.strictEqual(r[3], '142');
  assert.strictEqual(r[4], '');
  assert.match(r[6], /^001CASH WITHDRAWAL\nDESC: NO NOTES DISPENSED$/);
});

test('Diebold 12:35:57: some notes out → 128, no dispense; acc-cubc D912 shape counts the same', () => {
  assert.strictEqual(makeDdcDeviceFaultReply()(fault('?00001b05000002a00000003@00000004@0000000'), session).split(FS)[3], '128');
  assert.strictEqual(makeDdcDeviceFaultReply()(fault('@0054D00000001A00000002b00000003@0000000'), session).split(FS)[3], '142');
});

test('card reader faults (>7082, 4081) get no reply', () => {
  assert.strictEqual(makeDdcDeviceFaultReply()(fault('>7082'), session), null);
  assert.strictEqual(makeDdcDeviceFaultReply()(fault('4081'), session), null);
});
