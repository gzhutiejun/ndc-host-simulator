const test = require('node:test');
const assert = require('node:assert');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');
const { createApp } = require('../server');
const { FS } = require('../src/constants');
const { encodeLength, createDecoder } = require('../src/framing');
const baseConfig = require('../config-ndc-vm.json');

function send(port, text, timeoutMs = 400) {
  return new Promise((resolve, reject) => {
    const dec = createDecoder();
    const client = net.createConnection({ port }, () => client.write(encodeLength(Buffer.from(text, 'latin1'))));
    const timer = setTimeout(() => { client.destroy(); resolve(null); }, timeoutMs);
    client.on('data', (d) => {
      const frames = dec.push(d);
      if (frames.length) { clearTimeout(timer); resolve(frames[0].toString('latin1')); client.end(); }
    });
    client.on('error', reject);
  });
}

async function withApp(overrides, fn) {
  const config = {
    ...baseConfig, ...overrides, port: 0, uiPort: 0, pushOnConnect: [],
    captureDir: fs.mkdtempSync(path.join(os.tmpdir(), 'ndc-st-')),
    responseDelayMs: 0,
    messageLibrary: path.join(__dirname, '..', baseConfig.messageLibrary),
  };
  config.fitDownload = { ...(config.fitDownload || {}), beforeGoInService: false };
  const app = createApp(config);
  await new Promise((resolve) => app.server.listen(0, resolve));
  try { await fn(app.server.address().port); } finally { await new Promise((r) => app.server.close(r)); }
}

const jReq = (op) => ['11', '000', '', '', '17', ';X=X?', '', op].join(FS);
const p20 = ['12', '000', '', 'P20'].join(FS);

test('J 族请求得到 class 4 应答，凭条回显 MCN', { timeout: 5000 }, async () => {
  await withApp({}, async (port) => {
    for (const op of ['JA      ', 'JC      ', 'JG  X   '.replace('X', 'B'), 'C A     ']) {
      const f = (await send(port, jReq(op))).split(FS);
      assert.strictEqual(f[0], '4', op);
      assert.strictEqual(f[3], '001', op);
      assert.strictEqual(f[6][0], '7', op);
    }
  });
});

test('P20 之后自动 Go In Service', { timeout: 5000 }, async () => {
  await withApp({}, async (port) => {
    assert.strictEqual(await send(port, p20), '1' + FS + FS + FS + '1');
  });
});

test('autoGisOnP20:false 时 P20 无应答', { timeout: 5000 }, async () => {
  await withApp({ settlement: { ...baseConfig.settlement, autoGisOnP20: false } }, async (port) => {
    assert.strictEqual(await send(port, p20), null);
  });
});
