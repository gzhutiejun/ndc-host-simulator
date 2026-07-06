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
    let settled = false;
    client.on('data', (d) => {
      const frames = dec.push(d);
      if (frames.length && !settled) { settled = true; resolve(frames[0].toString('latin1')); client.end(); }
    });
    client.on('close', () => { if (!settled) { settled = true; reject(new Error('closed with no frame')); } });
    client.on('error', reject);
  });
}

function makeApp() {
  const capDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ndc-gen-'));
  return createApp({
    enableTLS: false, responseDelayMs: 0, captureDir: capDir,
    rules: [
      { name: 'withdrawal-request', match: { messageClass: '1', subClass: '1', field: { index: 7, startsWith: 'A' } }, handler: 'withdrawal' },
      { name: 'balance-inquiry', match: { messageClass: '1', subClass: '1', field: { index: 7, startsWith: 'C' } }, handler: 'balance' },
      { name: 'generic-fallback', match: { messageClass: '1', subClass: '1' }, handler: 'generic' },
    ],
    withdrawal: { cassettes: [50, 100, 500, 1000], approvedNextState: '123' },
    balance: { nextState: '074', amount: '5000.00', receipt: { screen: 'BAL <BALANCE>', printerData: '' } },
    generic: { nextState: '048', receipt: { screen: '', printerData: '' } },
  });
}

test('AAC withdrawal variant is approved (relaxed A-family match)', { timeout: 5000 }, async () => {
  const app = makeApp();
  await new Promise((resolve) => app.server.listen(0, resolve));
  const reply = await sendFrame(app.server.address().port, ['11', '000', '', '', '15', ';X=X?', '', 'AAC     ', '00000300'].join(FS));
  const f = reply.split(FS);
  assert.strictEqual(f[0], '4');
  assert.strictEqual(f[3], '123');       // approved
  assert.strictEqual(f[4], '00030000');  // dispense for 300
  await new Promise((resolve) => app.server.close(resolve));
});

test('non A/C TxnRequest (D-family) gets a 048 generic fallback reply, no dispense', { timeout: 5000 }, async () => {
  const app = makeApp();
  await new Promise((resolve) => app.server.listen(0, resolve));
  const reply = await sendFrame(app.server.address().port, ['11', '000', '', '', '15', ';X=X?', '', 'D       ', ''].join(FS));
  const f = reply.split(FS);
  assert.strictEqual(f[0], '4');
  assert.strictEqual(f[3], '048'); // safe cancel
  assert.strictEqual(f[4], '');    // no dispense
  await new Promise((resolve) => app.server.close(resolve));
});
