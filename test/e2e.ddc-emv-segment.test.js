const test = require('node:test');
const assert = require('node:assert');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');
const { createApp } = require('../server');
const { FS } = require('../src/constants');
const { encodeLength, createDecoder } = require('../src/framing');

// 现网真实样本（终端 008823，2024-01-15 07:44:56）的 HHH 应答就是 10 段形状，比出厂
// 7 段多出一段 EMV 边界标记（`'9''M'...`）。这条测的是打开 includeCam 之后能收到那一段，
// 而不是逐字节还原那条真实报文。
test('DDC HHH reply with includeCam carries the EMV boundary segment end-to-end', { timeout: 5000 }, async () => {
  const capDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ndc-ddc-emv-'));
  const app = createApp({
    enableTLS: false,
    responseDelayMs: 0,
    captureDir: capDir,
    rules: [
      { name: 'ddc-pin-validation',
        match: { messageClass: '1', subClass: '1', field: { index: 7, equals: 'HHH A   ' } },
        handler: 'ddcPinValidation' },
    ],
    ddcPinValidation: { includeCam: true, camArc: '00' },
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
  assert.strictEqual(f[3], '803');
  assert.strictEqual(f.length, 8);
  assert.strictEqual(f[7], "'9''M'3030");
  await new Promise((resolve) => app.server.close(resolve));
});
