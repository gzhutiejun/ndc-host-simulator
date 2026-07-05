const test = require('node:test');
const assert = require('node:assert');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');
const { createApp } = require('../server');
const { FS } = require('../src/constants');
const { encodeLength, createDecoder } = require('../src/framing');

test('ATM solicited status gets a Go-In-Service reply end-to-end', async () => {
  const capDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ndc-e2e-'));
  const app = createApp({
    enableTLS: false,
    responseDelayMs: 0,
    captureDir: capDir,
    rules: [{ name: 'ready9-go-in-service', match: { messageClass: '2', field: { index: 3, startsWith: '9' } }, handler: 'goInService' }],
  });
  await new Promise((resolve) => app.server.listen(0, resolve));
  const port = app.server.address().port;

  const reply = await new Promise((resolve, reject) => {
    const decoder = createDecoder();
    const client = net.createConnection({ port }, () => {
      client.write(encodeLength(Buffer.from('22' + FS + '123' + FS + FS + '9', 'latin1')));
    });
    client.on('data', (d) => {
      const frames = decoder.push(d);
      if (frames.length) {
        resolve(frames[0].toString('latin1'));
        client.end();
      }
    });
    client.on('error', reject);
  });

  assert.strictEqual(reply, '1' + FS + FS + FS + '1');
  await new Promise((resolve) => app.server.close(resolve));
});
