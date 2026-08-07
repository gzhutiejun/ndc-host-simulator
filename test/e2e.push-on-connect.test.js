const test = require('node:test');
const assert = require('node:assert');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');
const { createApp } = require('../server');
const { FS } = require('../src/constants');
const { createDecoder } = require('../src/framing');

test('连接建立后按 pushOnConnect 主动下发终端命令', async () => {
  const capDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ndc-push-'));
  const app = createApp({
    enableTLS: false,
    captureDir: capDir,
    rules: [],
    pushOnConnect: [{ code: 'Z', luno: '000' }],
  });
  await new Promise((resolve) => app.server.listen(0, resolve));
  const port = app.server.address().port;

  const pushed = await new Promise((resolve, reject) => {
    const decoder = createDecoder();
    const client = net.createConnection({ port });
    client.on('data', (d) => {
      const frames = decoder.push(d);
      if (frames.length) {
        resolve(frames[0].toString('latin1'));
        client.end();
      }
    });
    client.on('error', reject);
  });

  assert.strictEqual(pushed, '1' + FS + '000' + FS + FS + 'Z');
  await new Promise((resolve) => app.server.close(resolve));
});

test('未配置 pushOnConnect 时不主动发任何东西（默认行为不变）', async () => {
  const capDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ndc-nopush-'));
  const app = createApp({ enableTLS: false, captureDir: capDir, rules: [] });
  await new Promise((resolve) => app.server.listen(0, resolve));
  const port = app.server.address().port;

  const gotData = await new Promise((resolve, reject) => {
    const client = net.createConnection({ port });
    client.on('data', () => { resolve(true); client.end(); });
    client.on('error', reject);
    setTimeout(() => { resolve(false); client.end(); }, 200);
  });

  assert.strictEqual(gotData, false);
  await new Promise((resolve) => app.server.close(resolve));
});
