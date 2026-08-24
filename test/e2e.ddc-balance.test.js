const test = require('node:test');
const assert = require('node:assert');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');
const { createApp } = require('../server');
const { FS } = require('../src/constants');
const { encodeLength, createDecoder } = require('../src/framing');

test('DDC two-stage balance: BA A (055, no data) then BA B (063, balance) end-to-end', { timeout: 5000 }, async () => {
  const capDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ndc-ddc-bal-'));
  const app = createApp({
    enableTLS: false,
    responseDelayMs: 0,
    captureDir: capDir,
    rules: [
      { name: 'ddc-balance-stage1',
        match: { messageClass: '1', subClass: '1', field: { index: 7, startsWith: 'BA A' } },
        handler: 'ddcBalanceStage1' },
      { name: 'ddc-balance-stage2',
        match: { messageClass: '1', subClass: '1', field: { index: 7, startsWith: 'BA B' } },
        handler: 'ddcBalanceStage2' },
    ],
    ddcBalanceStage2: { amount: '892.61', receipt: { screen: 'BAL <BALANCE>' } },
  });
  await new Promise((resolve) => app.server.listen(0, resolve));
  const port = app.server.address().port;

  const dec = createDecoder();
  const replies = [];
  const client = await new Promise((resolve, reject) => {
    const c = net.createConnection({ port }, () => resolve(c));
    c.on('error', reject);
  });
  client.on('data', (d) => {
    for (const f of dec.push(d)) replies.push(f.toString('latin1'));
  });

  const stage1Req = [
    '11', 'CUB', '', '', '17', ';461760XXXXXX7710=XXXXXXXXXXXXXXXXXXXX?', '',
    'BA AAC ', '',
  ].join(FS);
  client.write(encodeLength(Buffer.from(stage1Req, 'latin1')));
  await new Promise((resolve) => { const t = setInterval(() => { if (replies.length >= 1) { clearInterval(t); resolve(); } }, 10); });

  const f1 = replies[0].split(FS);
  assert.strictEqual(f1[3], '055');
  assert.strictEqual(f1[4], '');

  const stage2Req = [
    '11', 'CUB', '', '', '18', ';461760XXXXXX7710=XXXXXXXXXXXXXXXXXXXX?', '',
    'BA BAC ', '',
  ].join(FS);
  client.write(encodeLength(Buffer.from(stage2Req, 'latin1')));
  await new Promise((resolve) => { const t = setInterval(() => { if (replies.length >= 2) { clearInterval(t); resolve(); } }, 10); });

  const f2 = replies[1].split(FS);
  assert.strictEqual(f2[3], '063');
  assert.strictEqual(f2[4], '');
  assert.strictEqual(f2[5], 'BAL 892.61');

  client.end();
  await new Promise((resolve) => app.server.close(resolve));
});
