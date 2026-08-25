const test = require('node:test');
const assert = require('node:assert');
const net = require('node:net');
const { createApp } = require('../server');
const { FS } = require('../src/constants');
const { encodeLength, createDecoder } = require('../src/framing');

test('ddc mini statement stage 1: CA AA C -> nextState 085', { timeout: 5000 }, async () => {
  const app = createApp({
    enableTLS: false,
    responseDelayMs: 0,
    rules: [
      { name: 'ddc-mini-statement-stage1',
        match: { messageClass: '1', subClass: '1', field: { index: 7, startsWith: 'CA AA C' } },
        handler: 'ddcMiniStatementStage1' },
    ],
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
    'CA AA C ', '',
  ].join(FS);
  client.write(encodeLength(Buffer.from(stage1Req, 'latin1')));
  await new Promise((resolve) => { const t = setInterval(() => { if (replies.length >= 1) { clearInterval(t); resolve(); } }, 10); });

  const f1 = replies[0].split(FS);
  assert.strictEqual(f1[0], '4');
  assert.strictEqual(f1[3], '085');
  assert.strictEqual(f1[4], '');

  client.end();
  await new Promise((resolve) => app.server.close(resolve));
});
