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

  try {
    const pushed = await new Promise((resolve, reject) => {
      const decoder = createDecoder();
      const client = net.createConnection({ port });
      const timer = setTimeout(() => {
        client.destroy();
        reject(new Error('no frame pushed within 2000ms'));
      }, 2000);
      client.on('data', (d) => {
        const frames = decoder.push(d);
        if (frames.length) {
          clearTimeout(timer);
          resolve(frames[0].toString('latin1'));
          client.end();
        }
      });
      client.on('error', (err) => {
        clearTimeout(timer);
        reject(err);
      });
    });

    assert.strictEqual(pushed, '1' + FS + '000' + FS + FS + 'Z');
  } finally {
    await new Promise((resolve) => app.server.close(resolve));
  }
});

test('未配置 pushOnConnect 时不主动发任何东西（默认行为不变）', async () => {
  const capDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ndc-nopush-'));
  const app = createApp({ enableTLS: false, captureDir: capDir, rules: [] });
  await new Promise((resolve) => app.server.listen(0, resolve));
  const port = app.server.address().port;

  try {
    const gotData = await new Promise((resolve, reject) => {
      const client = net.createConnection({ port });
      client.on('data', () => { resolve(true); client.end(); });
      client.on('error', reject);
      setTimeout(() => { resolve(false); client.end(); }, 200);
    });

    assert.strictEqual(gotData, false);
  } finally {
    await new Promise((resolve) => app.server.close(resolve));
  }
});
