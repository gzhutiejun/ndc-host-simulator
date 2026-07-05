const test = require('node:test');
const assert = require('node:assert');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');
const { createApp } = require('../server');
const { FS } = require('../src/constants');
const { encodeLength, createDecoder } = require('../src/framing');

function sendFrame(port, payload) {
  return new Promise((resolve, reject) => {
    const dec = createDecoder();
    const client = net.createConnection({ port }, () => {
      client.write(encodeLength(Buffer.from(payload, 'latin1')));
    });
    client.on('data', (d) => {
      const frames = dec.push(d);
      if (frames.length) { resolve(frames[0].toString('latin1')); client.end(); }
    });
    client.on('error', reject);
  });
}

function makeApp() {
  const capDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ndc-bd-'));
  return createApp({
    enableTLS: false, responseDelayMs: 0, captureDir: capDir,
    rules: [
      { name: 'withdrawal-request', match: { messageClass: '1', subClass: '1', field: { index: 7, equals: 'ADC     ' } }, handler: 'withdrawal' },
      { name: 'balance-inquiry', match: { messageClass: '1', subClass: '1', field: { index: 7, startsWith: 'C' } }, handler: 'balance' },
    ],
    withdrawal: { cassettes: [50, 100, 500, 1000], approvedNextState: '123', maxAmount: 1000, declineNextState: '048', declineReceipt: { printerData: 'DECLINED' } },
    balance: { nextState: '074', amount: '5000.00', receipt: { screen: 'BAL <BALANCE>', printerData: '' } },
  });
}

test('balance inquiry gets a 074 reply carrying the configured balance', { timeout: 5000 }, async () => {
  const app = makeApp();
  await new Promise((resolve) => app.server.listen(0, resolve));
  const reply = await sendFrame(app.server.address().port, ['11', '000', '', '', '15', ';X=X?', '', 'CC   C  ', ''].join(FS));
  const f = reply.split(FS);
  assert.strictEqual(f[0], '4');
  assert.strictEqual(f[3], '074');
  assert.strictEqual(f[4], '');
  assert.ok(f[5].includes('5000.00'));
  await new Promise((resolve) => app.server.close(resolve));
});

test('over-limit withdrawal gets a 048 decline reply with no dispense', { timeout: 5000 }, async () => {
  const app = makeApp();
  await new Promise((resolve) => app.server.listen(0, resolve));
  const reply = await sendFrame(app.server.address().port, ['11', '000', '', '', '15', ';X=X?', '', 'ADC     ', '00005000'].join(FS));
  const f = reply.split(FS);
  assert.strictEqual(f[0], '4');
  assert.strictEqual(f[3], '048');
  assert.strictEqual(f[4], '');
  await new Promise((resolve) => app.server.close(resolve));
});
