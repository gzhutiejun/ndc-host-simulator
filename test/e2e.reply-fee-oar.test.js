const test = require('node:test');
const assert = require('node:assert');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');
const { createApp } = require('../server');
const { FS } = require('../src/constants');
const { encodeLength, createDecoder } = require('../src/framing');

// 两份出厂配置里，replyFee / oarSelection 规则的位置与缺省关闭，以及打开后经规则引擎的真实走向。
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
      ...baseConfig, ...overrides, port: 0, uiPort: 0, pushOnConnect: [],
      captureDir: fs.mkdtempSync(path.join(os.tmpdir(), 'ndc-rf-')),
      responseDelayMs: 0,
      messageLibrary: path.join(__dirname, '..', baseConfig.messageLibrary),
    };
    config.fitDownload = { ...(config.fitDownload || {}), beforeGoInService: false };
    const app = createApp(config);
    await new Promise((resolve) => app.server.listen(0, resolve));
    try { await fn(app.server.address().port); } finally { await new Promise((r) => app.server.close(r)); }
  }
  const req = (opcode, bufferB = '') => ['11', '000', '', '', '17', ';X=X?', '', opcode, '00010000', '', bufferB, ''].join(FS);

  test(`${file}: 规则在 settlement-request 之后、opcode-library 之前，且两个场景缺省关闭`, () => {
    const names = baseConfig.rules.map((r) => r.name);
    const s = names.indexOf('settlement-request');
    const lib = names.indexOf('opcode-library');
    assert.deepStrictEqual(names.slice(s + 1, lib), ['reply-fee', 'oar-selection']);
    assert.strictEqual(baseConfig.replyFee.enabled, false);
    assert.strictEqual(baseConfig.oarSelection.enabled, false);
  });

  test(`${file}: 缺省关闭时取款请求照旧落到后面的规则（不被 replyFee / oarSelection 截走）`, { timeout: 5000 }, async () => {
    await withApp({}, async (port) => {
      const reply = await send(port, req('A A  A A'));
      assert.ok(reply === null || !reply.split(FS)[5]?.includes('Fee='));
      assert.ok(reply === null || reply.split(FS)[0] !== '3');
    });
  });

  test(`${file}: replyFee 打开：空格 -> 手续费应答；B -> 取消应答；A -> 交给后面的规则`, { timeout: 5000 }, async () => {
    await withApp({ replyFee: { ...baseConfig.replyFee, enabled: true } }, async (port) => {
      const fee = (await send(port, req('A A  A A'))).split(FS);
      assert.strictEqual(fee[0], '4');
      assert.strictEqual(fee[3], '008');
      const cancel = (await send(port, req('A A  ABA'))).split(FS);
      assert.strictEqual(cancel[3], '048');
      const accepted = (await send(port, req('A A  AAA'))).split(FS);
      assert.notStrictEqual(accepted[3], '008');
    });
  });

  test(`${file}: oarSelection 打开：首条回 ITR，选 A 放行，E 取消`, { timeout: 5000 }, async () => {
    await withApp({ oarSelection: { ...baseConfig.oarSelection, enabled: true } }, async (port) => {
      const itr = (await send(port, req('A A  A A'))).split(FS);
      assert.strictEqual(itr[0], '3');
      assert.ok(itr[3].startsWith('2'));
      assert.ok(itr[5].startsWith('FROM;'));
      const picked = await send(port, req('A A  A A', 'A'));
      assert.ok(picked === null || picked.split(FS)[0] !== '3');
      const cancelled = (await send(port, req('A A  A A', 'E'))).split(FS);
      assert.strictEqual(cancelled[0], '4');
      assert.strictEqual(cancelled[3], '048');
    });
  });
}
