const test = require('node:test');
const assert = require('node:assert');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');
const { createApp } = require('../server');
const { FS } = require('../src/constants');
const { encodeLength, createDecoder } = require('../src/framing');

test('withdrawal request gets an approved reply (next-state 123 + fieldG) end-to-end', async () => {
  const capDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ndc-wd-'));
  const app = createApp({
    enableTLS: false,
    responseDelayMs: 0,
    captureDir: capDir,
    rules: [
      { name: 'withdrawal-request',
        match: { messageClass: '1', subClass: '1', field: { index: 7, equals: 'ADC     ' } },
        handler: 'withdrawal' },
    ],
    withdrawal: { cassettes: [50, 100, 500, 1000], approvedNextState: '123', receipt: { printerData: 'AED <AMOUNT>' } },
  });
  await new Promise((resolve) => app.server.listen(0, resolve));
  const port = app.server.address().port;

  const reply = await new Promise((resolve, reject) => {
    const dec = createDecoder();
    const req = ['11', '000', '', '', '15', ';XXXX=XXXX?', '', 'ADC     ', '00000300'].join(FS);
    const client = net.createConnection({ port }, () => {
      client.write(encodeLength(Buffer.from(req, 'latin1')));
    });
    client.on('data', (d) => {
      const frames = dec.push(d);
      if (frames.length) { resolve(frames[0].toString('latin1')); client.end(); }
    });
    client.on('error', reject);
  });

  const f = reply.split(FS);
  assert.strictEqual(f[0], '4');       // TransactionReply
  assert.strictEqual(f[3], '123');     // approved next-state
  assert.strictEqual(f[4], '00030000'); // fieldG for 300 (greedy 3x100)
  await new Promise((resolve) => app.server.close(resolve));
});
