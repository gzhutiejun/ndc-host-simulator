const test = require('node:test');
const assert = require('node:assert');
const net = require('node:net');
const fs = require('node:fs');
const path = require('node:path');
const { createApp } = require('../server');
const { FS } = require('../src/constants');
const { encodeLength, createDecoder } = require('../src/framing');

// 他行卡（方案书 §4.3 后两列）与 CUBC 的 ITR 回送形状，用 config-ddc.json 的完整规则表跑。
const ddc = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'config-ddc.json'), 'utf8'));

async function withApp(fn) {
  const app = createApp({ ...ddc, enableTLS: false, responseDelayMs: 0, messageLibrary: undefined,
    rules: ddc.rules.filter((r) => r.libraryKey == null && r.libraryKeyFromField == null) });
  await new Promise((resolve) => app.server.listen(0, resolve));
  const dec = createDecoder();
  const replies = [];
  const client = await new Promise((resolve, reject) => {
    const c = net.createConnection({ port: app.server.address().port }, () => resolve(c));
    c.on('error', reject);
  });
  client.on('data', (d) => { for (const f of dec.push(d)) replies.push(f.toString('latin1')); });
  let mcn = 0x31;
  const write = async (fields) => {
    const n = replies.length;
    client.write(encodeLength(Buffer.from(fields.join(FS), 'latin1')));
    await new Promise((resolve) => { const t = setInterval(() => { if (replies.length > n) { clearInterval(t); resolve(); } }, 10); });
    return replies[n].split(FS);
  };
  const send = (opcode, amount = '000000000000') =>
    write(['11', 'CUB', '', '', `1${String.fromCharCode(mcn++)}`, ';422131XXXXXX7329=XXXXXXXXXXXXXXXXXXXX?', '', opcode, amount, ':;<=>?12', '', '']);
  // 现网形状：11 CUB FS FS FS 1; FS×6 <key> FS
  const confirm = (key) =>
    write(['11', 'CUB', '', '', `1${String.fromCharCode(mcn++)}`, '', '', '', '', '', key, '']);
  try { await fn(send, confirm); } finally {
    client.end();
    await new Promise((resolve) => app.server.close(resolve));
  }
}

const isItr = (r) => r[0] === '3' && r[3].startsWith('2');

test('国际卡取款 AA?D：手续费 ITR（I=）→ 回送 C → 128 出钞', { timeout: 5000 }, async () => {
  await withApp(async (send, confirm) => {
    const itr = await send('AABDABC ', '000090000000'); // 现网：900,000.00 KHR
    assert.ok(isItr(itr));
    assert.match(itr[5], /I=[\d.]+$/);
    const r = await confirm('C');
    assert.strictEqual(r[3], '128');
    assert.notStrictEqual(r[4], '');
  });
});

test('国际卡取款：回送 D → 131（现网 2024-02-25 15:05:14）', { timeout: 5000 }, async () => {
  await withApp(async (send, confirm) => {
    assert.ok(isItr(await send('AAADAAC ', '000000010000')));
    assert.strictEqual((await confirm('D'))[3], '131');
  });
});

test('国际卡余额 BA?F：手续费 ITR → C → 063', { timeout: 5000 }, async () => {
  await withApp(async (send, confirm) => {
    assert.ok(isItr(await send('BAAFA C ')));
    assert.strictEqual((await confirm('C'))[3], '063');
  });
});

// 他行 CSS 卡手续费段回普通交易应答（不是 ITR）：551 / 071 / 089 / 102 + Z000933（Diebold trace 2020）。
test('他行 CSS 卡取款：AAFF → 551（Z000933）→ AAFG → 128', { timeout: 5000 }, async () => {
  await withApp(async (send) => {
    const fee = await send('AAFFAAC ', '000000005000');
    assert.strictEqual(fee[0], '4');
    assert.strictEqual(fee[3], '551');
    assert.ok(fee[5].includes('Z0009330.45 USD'));
    assert.strictEqual((await send('AAFGAAC ', '000000005000'))[3], '128');
  });
});

test('他行 CSS 卡余额 / 对账单 / 改密：手续费段回本族阶段码，授权段给结论（改密 BB F / BB D，位 3 空格）', { timeout: 5000 }, async () => {
  await withApp(async (send) => {
    assert.strictEqual((await send('BAFCABC '))[3], '071');
    assert.strictEqual((await send('BAFDABC '))[3], '063');

    assert.strictEqual((await send('CAFDABC '))[3], '089');
    assert.strictEqual((await send('CAFCABC '))[3], '093');

    assert.strictEqual((await send('BB FABC '))[3], '102');
    assert.strictEqual((await send('BB DABC '))[3], '123');
  });
});

test('本行改密 BBFD → 123（现网 [BBFDB C ] →(123)）', { timeout: 5000 }, async () => {
  await withApp(async (send) => {
    assert.strictEqual((await send('BBFDB C '))[3], '123');
  });
});

test('转他人户的 ITR 回送也可以只带 Buffer B：合并到本会话上一条 GD H', { timeout: 5000 }, async () => {
  await withApp(async (send, confirm) => {
    assert.ok(isItr(await send('GD HA C ', '000000000258')));
    assert.strictEqual((await confirm('C'))[3], '130');
  });
});

test('跨行转账 DF（他行 CSS 卡）：DFFB → 814 → DFFC → 861 → DFFD → 820 → DFFF → 209 → C → 822 → DFFG → 130', { timeout: 5000 }, async () => {
  await withApp(async (send, confirm) => {
    assert.strictEqual((await send('DFFBAB  '))[3], '814');
    assert.strictEqual((await send('DFFCAB  '))[3], '861');
    assert.strictEqual((await send('DFFDABC ', '000000200000'))[3], '820');
    assert.ok(isItr(await send('DFFFABC ', '000000200000')));
    assert.strictEqual((await confirm('C'))[3], '822');
    assert.strictEqual((await send('DFFGABC ', '000000200000'))[3], '130');
  });
});
