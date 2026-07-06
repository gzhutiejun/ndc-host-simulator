const test = require('node:test');
const assert = require('node:assert');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');
const { createApp } = require('../server');
const { FS } = require('../src/constants');
const { encodeLength, createDecoder } = require('../src/framing');

function sendFrame(port, payload) {
  return new Promise((resolve, reject) => {
    const dec = createDecoder();
    const client = net.createConnection({ port }, () => {
      client.write(encodeLength(Buffer.from(payload, 'latin1')));
    });
    let settled = false;
    client.on('data', (d) => {
      const frames = dec.push(d);
      if (frames.length && !settled) { settled = true; resolve(frames[0].toString('latin1')); client.end(); }
    });
    client.on('close', () => { if (!settled) { settled = true; reject(new Error('closed with no frame')); } });
    client.on('error', reject);
  });
}

function makeApp() {
  const capDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ndc-gen-'));
  return createApp({
    enableTLS: false, responseDelayMs: 0, captureDir: capDir,
    rules: [
      { name: 'withdrawal-request', match: { messageClass: '1', subClass: '1', field: { index: 7, startsWith: 'A' } }, handler: 'withdrawal' },
      { name: 'balance-inquiry', match: { messageClass: '1', subClass: '1', field: { index: 7, startsWith: 'C' } }, handler: 'balance' },
      { name: 'd-family-reply', match: { messageClass: '1', subClass: '1', field: { index: 7, startsWith: 'D' } }, handler: 'familyD' },
      { name: 'i-family-reply', match: { messageClass: '1', subClass: '1', field: { index: 7, startsWith: 'I' } }, handler: 'familyI' },
      { name: 'generic-fallback', match: { messageClass: '1', subClass: '1' }, handler: 'generic' },
    ],
    withdrawal: { cassettes: [50, 100, 500, 1000], approvedNextState: '123' },
    balance: { nextState: '074', amount: '5000.00', receipt: { screen: 'BAL <BALANCE>', printerData: '' } },
    familyD: { nextState: '698', receipt: { screen: '', printerData: '' } },
    familyI: { nextState: '175', receipt: { screen: '', printerData: '' } },
    generic: { nextState: '048', receipt: { screen: '', printerData: '' } },
  });
}

test('AAC withdrawal variant is approved (relaxed A-family match)', { timeout: 5000 }, async () => {
  const app = makeApp();
  await new Promise((resolve) => app.server.listen(0, resolve));
  const reply = await sendFrame(app.server.address().port, ['11', '000', '', '', '15', ';X=X?', '', 'AAC     ', '00000300'].join(FS));
  const f = reply.split(FS);
  assert.strictEqual(f[0], '4');
  assert.strictEqual(f[3], '123');       // approved
  assert.strictEqual(f[4], '00030000');  // dispense for 300
  await new Promise((resolve) => app.server.close(resolve));
});

test('A-family withdrawal with an empty amount falls through to the 048 generic fallback (no timeout)', { timeout: 5000 }, async () => {
  const app = makeApp();
  await new Promise((resolve) => app.server.listen(0, resolve));
  // field[7]='A       ' 命中 withdrawal 规则，但 field[8] 金额为空 → withdrawal handler 返回 null
  const reply = await sendFrame(app.server.address().port, ['11', '000', '', '', '15', ';X=X?', '', 'A       ', ''].join(FS));
  const f = reply.split(FS);
  assert.strictEqual(f[0], '4');   // TransactionReply
  assert.strictEqual(f[3], '048'); // generic 安全取消，而非无应答超时
  assert.strictEqual(f[4], '');    // fieldG 空，不出钞
  await new Promise((resolve) => app.server.close(resolve));
});

test('D-family class1-sub1 request gets a 698 family-specific reply (no dispense)', { timeout: 5000 }, async () => {
  const app = makeApp();
  await new Promise((resolve) => app.server.listen(0, resolve));
  const reply = await sendFrame(app.server.address().port, ['11', '000', '', '', '15', ';X=X?', '', 'D       ', ''].join(FS));
  const f = reply.split(FS);
  assert.strictEqual(f[0], '4');   // TransactionReply
  assert.strictEqual(f[3], '698'); // D-family observed next-state (was 048 under generic)
  assert.strictEqual(f[4], '');    // no dispense
  await new Promise((resolve) => app.server.close(resolve));
});

test('I-family class1-sub1 request gets a 175 family-specific reply (no dispense)', { timeout: 5000 }, async () => {
  const app = makeApp();
  await new Promise((resolve) => app.server.listen(0, resolve));
  const reply = await sendFrame(app.server.address().port, ['11', '000', '', '', '15', ';X=X?', '', 'I       ', ''].join(FS));
  const f = reply.split(FS);
  assert.strictEqual(f[0], '4');
  assert.strictEqual(f[3], '175'); // I-family observed next-state
  assert.strictEqual(f[4], '');
  await new Promise((resolve) => app.server.close(resolve));
});

test('non A/C/D/I class1-sub1 request still gets the 048 generic fallback', { timeout: 5000 }, async () => {
  const app = makeApp();
  await new Promise((resolve) => app.server.listen(0, resolve));
  const reply = await sendFrame(app.server.address().port, ['11', '000', '', '', '15', ';X=X?', '', 'Z       ', ''].join(FS));
  const f = reply.split(FS);
  assert.strictEqual(f[0], '4');
  assert.strictEqual(f[3], '048'); // unchanged: still safe generic cancel
  assert.strictEqual(f[4], '');
  await new Promise((resolve) => app.server.close(resolve));
});
