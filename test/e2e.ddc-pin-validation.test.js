const test = require('node:test');
const assert = require('node:assert');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');
const { createApp } = require('../server');
const { FS } = require('../src/constants');
const { encodeLength, createDecoder } = require('../src/framing');

test('DDC HHH request gets an approved reply (next-state 803, no dispense) end-to-end', { timeout: 5000 }, async () => {
  const capDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ndc-ddc-'));
  const app = createApp({
    enableTLS: false,
    responseDelayMs: 0,
    captureDir: capDir,
    rules: [
      { name: 'ddc-pin-validation',
        match: { messageClass: '1', subClass: '1', field: { index: 7, equals: 'HHH A   ' } },
        handler: 'ddcPinValidation' },
    ],
  });
  await new Promise((resolve) => app.server.listen(0, resolve));
  const port = app.server.address().port;

  const reply = await new Promise((resolve, reject) => {
    const dec = createDecoder();
    const req = [
      '11', 'CUB', '', '', '15', ';461760XXXXXX7710=XXXXXXXXXXXXXXXXXXXX?', '',
      'HHH A   ', '000000000000',
    ].join(FS);
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
  assert.strictEqual(f[1], 'CUB');     // LUNO echoed
  assert.strictEqual(f[3], '803');     // "this stage passed" next-state
  assert.strictEqual(f[4], '');        // fieldG — no dispense
  await new Promise((resolve) => app.server.close(resolve));
});
