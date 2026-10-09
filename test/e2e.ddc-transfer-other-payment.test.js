const test = require('node:test');
const assert = require('node:assert');
const net = require('node:net');
const fs = require('node:fs');
const path = require('node:path');
const { createApp } = require('../server');
const { FS } = require('../src/constants');
const { encodeLength, createDecoder } = require('../src/framing');

// 用 config-ddc.json 里真正的规则与配置节，验证接线（规则名、handler 名、配置节名）。
const ddc = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'config-ddc.json'), 'utf8'));
const rules = ddc.rules.filter((r) => r.handler === 'ddcTransferOther' || r.handler === 'ddcCardPayment');

async function withApp(fn, overrides = {}) {
  const app = createApp({
    enableTLS: false, responseDelayMs: 0, rules,
    ddcTransferOther: ddc.ddcTransferOther, ddcCardPayment: ddc.ddcCardPayment,
    ...overrides,
  });
  await new Promise((resolve) => app.server.listen(0, resolve));
  const dec = createDecoder();
  const replies = [];
  const client = await new Promise((resolve, reject) => {
    const c = net.createConnection({ port: app.server.address().port }, () => resolve(c));
    c.on('error', reject);
  });
  client.on('data', (d) => { for (const f of dec.push(d)) replies.push(f.toString('latin1')); });
  const send = async (opcode, amount, b, c) => {
    const n = replies.length;
    const msg = ['11', 'CUB', '', '', '17', ';422131XXXXXX7329=XXXXXXXXXXXXXXXXXXXX?', '', opcode, amount, ':;<=>?12', b, c].join(FS);
    client.write(encodeLength(Buffer.from(msg, 'latin1')));
    await new Promise((resolve) => { const t = setInterval(() => { if (replies.length > n) { clearInterval(t); resolve(); } }, 10); });
    return replies[n].split(FS);
  };
  try { await fn(send); } finally {
    client.end();
    await new Promise((resolve) => app.server.close(resolve));
  }
}

test('config-ddc.json 为 7 个操作码各配了一条规则', () => {
  assert.deepStrictEqual(rules.map((r) => r.match.field.startsWith).sort(),
    ['FG A', 'FG B', 'FG C', 'FG D', 'GD F', 'GD G', 'GD H']);
});

test('转他人户整段：GD F → ITR → GD F(A) → 430 → GD G → 434 → GD H → ITR → GD H(C) → 130', { timeout: 5000 }, async () => {
  await withApp(async (send) => {
    assert.strictEqual((await send('GD FA C ', '000000000000', '', ''))[0], '3');
    assert.strictEqual((await send('GD FA C ', '000000000000', 'A', ''))[3], '430');
    assert.strictEqual((await send('GD GA C ', '000000000258', '01110110281087', ''))[3], '434');
    assert.strictEqual((await send('GD HA C ', '000000000258', '01110110281087', ''))[0], '3');
    assert.strictEqual((await send('GD HA C ', '000000000258', 'C', ''))[3], '130');
  });
});

test('信用卡缴款整段：FG A → ITR → FG A(A) → 382 → FG B → 385 → FG C → 390 → FG D → 130', { timeout: 5000 }, async () => {
  await withApp(async (send) => {
    assert.strictEqual((await send('FG AA C ', '000000000000', '', ''))[0], '3');
    assert.strictEqual((await send('FG AA C ', '000000000000', 'A', ''))[3], '382');
    assert.strictEqual((await send('FG BA C ', '000000000000', '', '4043188686581509'))[3], '385');
    assert.strictEqual((await send('FG CA C ', '000000000658', '', '4043188686581509'))[3], '390');
    assert.strictEqual((await send('FG DA C ', '000000000658', '', '4043188686581509'))[3], '130');
  });
});

test('拒绝开关接线：无效账号/卡号 → 149；config-ddc.json 缺省为关', { timeout: 5000 }, async () => {
  assert.strictEqual(ddc.ddcTransferOther.invalidAccount, '');
  assert.strictEqual(ddc.ddcCardPayment.invalidCard, '');
  await withApp(async (send) => {
    assert.strictEqual((await send('GD GA C ', '000000000258', '01110110999999', ''))[3], '149');
    assert.strictEqual((await send('FG BA C ', '000000000000', '', '4000000000000002'))[3], '149');
  }, {
    ddcTransferOther: { ...ddc.ddcTransferOther, invalidAccount: '01110110999999' },
    ddcCardPayment: { ...ddc.ddcCardPayment, invalidCard: '4000000000000002' },
  });
});

test('完整 config-ddc.json 规则表：旧规则不被抢，新帧命中新 handler', { timeout: 5000 }, async () => {
  const app = createApp({ ...ddc, enableTLS: false, responseDelayMs: 0 });
  await new Promise((resolve) => app.server.listen(0, resolve));
  const dec = createDecoder();
  const replies = [];
  const client = await new Promise((resolve, reject) => {
    const c = net.createConnection({ port: app.server.address().port }, () => resolve(c));
    c.on('error', reject);
  });
  client.on('data', (d) => { for (const f of dec.push(d)) replies.push(f.toString('latin1')); });
  const send = async (opcode, amount, b, c) => {
    const n = replies.length;
    const msg = ['11', 'CUB', '', '', '17', ';422131XXXXXX7329=XXXXXXXXXXXXXXXXXXXX?', '', opcode, amount, ':;<=>?12', b, c].join(FS);
    client.write(encodeLength(Buffer.from(msg, 'latin1')));
    await new Promise((resolve) => { const t = setInterval(() => { if (replies.length > n) { clearInterval(t); resolve(); } }, 10); });
    return replies[n].split(FS);
  };
  try {
    // config-ddc.json 打开了 accountList / confirm（样本四份）：GD B 源账户列表 → 目标账户列表 → 882；
    // GD C 确认屏 209 → C → 130。ATM 的回送只有新 MCN + Buffer B（opcode 空），模拟器并回上一条再分派。
    assert.strictEqual((await send('GD BA CC', '', '', ''))[0], '3');
    assert.strictEqual((await send('', '', 'B', ''))[0], '3');
    assert.strictEqual((await send('', '', 'A', ''))[3], '882');
    assert.strictEqual((await send('GD CA C ', '000000000258', '', ''))[0], '3');
    assert.strictEqual((await send('', '', 'C', ''))[3], '130');
    assert.strictEqual((await send('GD FA C ', '000000000000', '', ''))[0], '3');
    assert.strictEqual((await send('GD GA C ', '000000000258', '01110110281087', ''))[3], '434');
    assert.strictEqual((await send('GD HA C ', '000000000258', 'C', ''))[3], '130');
    assert.strictEqual((await send('FG AA C ', '000000000000', 'A', ''))[3], '382');
    assert.strictEqual((await send('FG BA C ', '000000000000', '', '4043188686581509'))[3], '385');
    assert.strictEqual((await send('FG CA C ', '000000000658', '', '4043188686581509'))[3], '390');
    assert.strictEqual((await send('FG DA C ', '000000000658', '', '4043188686581509'))[3], '130');
  } finally {
    client.end();
    await new Promise((resolve) => app.server.close(resolve));
  }
});

test('限额开关经 createApp 配置生效：162；单账户开关：直达 430/382', { timeout: 5000 }, async () => {
  await withApp(async (send) => {
    assert.strictEqual((await send('GD HA C ', '000000000258', 'C', ''))[3], '162');
    assert.strictEqual((await send('FG CA C ', '000000000658', '', '4043188686581509'))[3], '162');
    assert.strictEqual((await send('GD FA C ', '000000000000', '', ''))[3], '430');
    assert.strictEqual((await send('FG AA C ', '000000000000', '', ''))[3], '382');
  }, {
    ddcTransferOther: { ...ddc.ddcTransferOther, limitCents: 100, singleAccount: true },
    ddcCardPayment: { ...ddc.ddcCardPayment, limitCents: 500, singleAccount: true },
  });
});
