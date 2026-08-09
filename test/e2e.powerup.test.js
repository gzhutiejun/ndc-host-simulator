const test = require('node:test');
const assert = require('node:assert');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');
const { createApp } = require('../server');
const { FS } = require('../src/constants');
const { encodeLength, createDecoder } = require('../src/framing');

function waitForFrame(port, toSend, timeoutMs = 2000) {
  return new Promise((resolve, reject) => {
    const decoder = createDecoder();
    const client = net.createConnection({ port }, () => {
      client.write(encodeLength(Buffer.from(toSend, 'latin1')));
    });
    const timer = setTimeout(() => {
      client.destroy();
      resolve(null);              // 没有应答 —— 由调用方判断这是否符合预期
    }, timeoutMs);
    client.on('data', (d) => {
      const frames = decoder.push(d);
      if (frames.length) {
        clearTimeout(timer);
        resolve(frames[0].toString('latin1'));
        client.end();
      }
    });
    client.on('error', (err) => { clearTimeout(timer); reject(err); });
  });
}

function startApp(rules) {
  const capDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ndc-powerup-'));
  const app = createApp({ enableTLS: false, captureDir: capDir, rules });
  return app;
}

const RULES = [
  { name: 'powerup-go-in-service',
    match: { messageClass: '1', subClass: '2', field: { index: 3, startsWith: 'B' } },
    handler: 'goInService' },
  { name: 'unsolicited-status-no-reply',
    match: { messageClass: '1', subClass: '2' }, noReply: true },
  { name: 'ready-no-reply',
    match: { messageClass: '2' }, noReply: true },
];

test('上电报文触发 Go in-service 命令', async () => {
  const app = startApp(RULES);
  await new Promise((r) => app.server.listen(0, r));
  try {
    const reply = await waitForFrame(app.server.address().port,
      '12' + FS + '000' + FS + FS + 'B0001');
    assert.strictEqual(reply, '1' + FS + FS + FS + '1');
  } finally {
    await new Promise((r) => app.server.close(r));
  }
});

test('Ready 9 不再触发 Go in-service —— 否则与 ATM 的 Ready 打成无限循环', async () => {
  const app = startApp(RULES);
  await new Promise((r) => app.server.listen(0, r));
  try {
    const reply = await waitForFrame(app.server.address().port,
      '22' + FS + '000' + FS + FS + '9', 500);
    assert.strictEqual(reply, null);
  } finally {
    await new Promise((r) => app.server.close(r));
  }
});

test('DIG 不是 B 的 unsolicited 状态报文不触发 Go in-service', async () => {
  const app = startApp(RULES);
  await new Promise((r) => app.server.listen(0, r));
  try {
    const reply = await waitForFrame(app.server.address().port,
      '12' + FS + '000' + FS + FS + 'E0', 500);
    assert.strictEqual(reply, null);
  } finally {
    await new Promise((r) => app.server.close(r));
  }
});
