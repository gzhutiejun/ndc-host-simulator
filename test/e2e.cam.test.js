const test = require('node:test');
const assert = require('node:assert');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');
const http = require('node:http');
const { createApp } = require('../server');
const { FS } = require('../src/constants');
const { encodeLength, createDecoder } = require('../src/framing');

// 8b：两份出厂配置里 cam 缺省全关、digc-reply 排在 status 规则之前，打开后经真实规则引擎的走向，
// 以及 /api/push type=emv 下发一帧报文类 8。
for (const file of ['config.json', 'config-ndc-vm.json']) {
  const baseConfig = require('../' + file);

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
      ...baseConfig, ...overrides, port: 0, uiPort: 1, pushOnConnect: [],
      captureDir: fs.mkdtempSync(path.join(os.tmpdir(), 'ndc-cam-')),
      responseDelayMs: 0,
      messageLibrary: path.join(__dirname, '..', baseConfig.messageLibrary),
    };
    config.fitDownload = { ...(config.fitDownload || {}), beforeGoInService: false };
    const app = createApp(config);
    await new Promise((resolve) => app.server.listen(0, resolve));
    try { await fn(app); } finally { await new Promise((r) => app.server.close(r)); }
  }
  const camReq = () => ['11', '000', '', '', '17', ';X=X?', '', 'A A  A A', '00010000', '', '', '', '5CAM0004'].join(FS);
  const digC = () => ['22', '000', '', '8', 'c1', '2', 'CAM9F0607A0000000031010'].join(FS);

  test(`${file}: cam 缺省关闭，digc-reply 排在 status 规则之前`, () => {
    assert.strictEqual(baseConfig.cam.enabled, false);
    assert.strictEqual(baseConfig.cam.digCReply.enabled, false);
    const names = baseConfig.rules.map((r) => r.name);
    const d = names.indexOf('digc-reply');
    assert.ok(d > 0);
    for (const n of ['ready9-no-reply', 'ddc-device-fault-reply']) {
      if (names.includes(n)) assert.ok(d < names.indexOf(n), n);
    }
  });

  test(`${file}: 缺省关闭时应答不带 CAM，DIG c 不应答`, { timeout: 5000 }, async () => {
    await withApp({}, async (app) => {
      const port = app.server.address().port;
      const reply = await send(port, camReq());
      assert.ok(reply === null || !reply.includes('5CAM'));
      assert.strictEqual(await send(port, digC()), null);
    });
  });

  test(`${file}: cam.enabled 后交易应答末尾带 CAM；digCReply 打开后 DIG c 得 class 4`, { timeout: 5000 }, async () => {
    const cam = { ...baseConfig.cam, enabled: true, digCReply: { ...baseConfig.cam.digCReply, enabled: true, nextState: '077' } };
    await withApp({ cam }, async (app) => {
      const port = app.server.address().port;
      const reply = await send(port, camReq());
      assert.ok(reply.endsWith(FS + '5CAM910A11223344556677883030' + '8A023030'), reply);
      const dig = (await send(port, digC())).split(FS);
      assert.strictEqual(dig[0], '4');
      assert.strictEqual(dig[3], '077');
    });
  });

  test(`${file}: /api/push type=emv 下发一帧首字符 8`, { timeout: 5000 }, async () => {
    await withApp({}, async (app) => {
      const port = app.server.address().port;
      await new Promise((resolve) => app.ui.listen(0, resolve));
      const uiPort = app.ui.server.address().port;
      try {
        const frame = await new Promise((resolve, reject) => {
          const dec = createDecoder();
          const client = net.createConnection({ port }, () => {
            setTimeout(() => {
              const body = JSON.stringify({ type: 'emv', subclass: '1', data: 'ABC', luno: '000' });
              const r = http.request({ port: uiPort, method: 'POST', path: '/api/push', headers: { 'Content-Type': 'application/json' } },
                (res) => res.resume());
              r.on('error', reject);
              r.end(body);
            }, 100);
          });
          client.on('data', (d) => {
            const frames = dec.push(d);
            if (frames.length) { client.end(); resolve(frames[0].toString('latin1')); }
          });
          client.on('error', reject);
        });
        assert.strictEqual(frame, ['8', '000', '1', 'ABC'].join(FS));
      } finally {
        await new Promise((r) => app.ui.close(r));
      }
    });
  });
}
