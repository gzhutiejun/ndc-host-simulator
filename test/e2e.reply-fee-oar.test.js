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
  // 会话随连接走：跟进要在同一条连接上发，存底才拿得到。每帧等一条应答（超时记 null）再发下一帧。
  function sendMany(port, texts, timeoutMs = 400) {
    return new Promise((resolve, reject) => {
      const dec = createDecoder();
      const replies = [];
      let timer = null;
      const client = net.createConnection({ port }, () => next());
      function next() {
        if (replies.length === texts.length) { client.end(); resolve(replies); return; }
        client.write(encodeLength(Buffer.from(texts[replies.length], 'latin1')));
        timer = setTimeout(() => { replies.push(null); next(); }, timeoutMs);
      }
      client.on('data', (d) => {
        for (const frame of dec.push(d)) {
          clearTimeout(timer);
          replies.push(frame.toString('latin1'));
          next();
        }
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
  // ATM 剥过字段的跟进：generic 清段 5–9，oar 另清段 11。
  const stripped = (bufferB, mcn = '18') => ['11', '000', '', '', mcn, '', '', '', '', '', bufferB, ''].join(FS);

  test(`${file}: 规则在 settlement-request 之后、opcode-library 之前，且两个场景缺省关闭`, () => {
    const names = baseConfig.rules.map((r) => r.name);
    const s = names.indexOf('settlement-request');
    const lib = names.indexOf('opcode-library');
    assert.deepStrictEqual(names.slice(s + 1, lib), ['reply-fee', 'oar-selection', 'generic-selection']);
    assert.strictEqual(baseConfig.replyFee.enabled, false);
    assert.strictEqual(baseConfig.oarSelection.enabled, false);
    assert.strictEqual(baseConfig.genericSelection.enabled, false);
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

  test(`${file}: genericSelection 打开（itr）：首条回 ITR，剥过的跟进（B=A）落到后面的规则拿到取款应答（类 4，非 ITR）`, { timeout: 5000 }, async () => {
    await withApp({ genericSelection: { ...baseConfig.genericSelection, enabled: true } }, async (port) => {
      const [itr, reply] = await sendMany(port, [req('A A  A A'), stripped('A')]);
      const f = itr.split(FS);
      assert.strictEqual(f[0], '3');
      assert.ok(f[5].startsWith('CONDITIONAL=LITERAL;'));
      assert.ok(reply, '跟进要有应答');
      assert.strictEqual(reply.split(FS)[0], '4');
    });
  });

  test(`${file}: genericSelection 打开（itr）：剥过的跟进 B=E 回取消应答`, { timeout: 5000 }, async () => {
    await withApp({ genericSelection: { ...baseConfig.genericSelection, enabled: true } }, async (port) => {
      const [, cancel] = await sendMany(port, [req('A A  A A'), stripped('E')]);
      assert.strictEqual(cancel.split(FS)[3], '048');
    });
  });

  test(`${file}: oarSelection reply 模式：首条回类 4 NS 071，剥过的跟进 B=1 拿到取款应答`, { timeout: 5000 }, async () => {
    await withApp({ oarSelection: { ...baseConfig.oarSelection, enabled: true, path: 'reply' } }, async (port) => {
      const [first, reply] = await sendMany(port, [req('A A  A A'), stripped('1')]);
      const f = first.split(FS);
      assert.strictEqual(f[0], '4');
      assert.strictEqual(f[3], '071');
      assert.ok(f[5].includes(';Account1Number='));
      assert.ok(reply, '跟进要有应答');
      const r = reply.split(FS);
      assert.strictEqual(r[0], '4');
      assert.ok(!['071', '073', '048'].includes(r[3]), `NS ${r[3]}`);
    });
  });
}
