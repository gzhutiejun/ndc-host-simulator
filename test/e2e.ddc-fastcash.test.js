const test = require('node:test');
const assert = require('node:assert');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');
const { createApp } = require('../server');
const { FS } = require('../src/constants');
const { encodeLength, createDecoder } = require('../src/framing');

// 快捷取款：第 1 段操作码基码 "AA A"（不是普通取款的 "AA B"），next-state 503
// （不是 547）；第 2 段与普通取款**共用**"AA C" -> 128，同一条 ddc-withdrawal-stage2
// 规则，不需要新规则/新 handler。ddcFastCashStage1 复用 ddcWithdrawalStage1 的
// 工厂函数、换一个缺省 nextState——跟 server.js 里 familyD/familyI 复用同一个
// makeGeneric 工厂、只换 nextState 是同一个模式。
test('DDC fast cash: AA A (503, no dispense) then AA C (128, dispenses, shared with regular withdrawal) end-to-end', { timeout: 5000 }, async () => {
  const capDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ndc-ddc-fc-'));
  const app = createApp({
    enableTLS: false,
    responseDelayMs: 0,
    captureDir: capDir,
    rules: [
      { name: 'ddc-fastcash-stage1',
        match: { messageClass: '1', subClass: '1', field: { index: 7, startsWith: 'AA A' } },
        handler: 'ddcFastCashStage1' },
      { name: 'ddc-withdrawal-stage2',
        match: { messageClass: '1', subClass: '1', field: { index: 7, startsWith: 'AA C' } },
        handler: 'ddcWithdrawalStage2' },
    ],
    ddcWithdrawalStage2: { cassettes: [50, 100, 500, 1000] },
  });
  await new Promise((resolve) => app.server.listen(0, resolve));
  const port = app.server.address().port;

  const dec = createDecoder();
  const replies = [];
  const client = await new Promise((resolve, reject) => {
    const c = net.createConnection({ port }, () => resolve(c));
    c.on('error', reject);
  });
  client.on('data', (d) => {
    for (const f of dec.push(d)) replies.push(f.toString('latin1'));
  });

  const stage1Req = [
    '11', 'CUB', '', '', '17', ';461760XXXXXX7710=XXXXXXXXXXXXXXXXXXXX?', '',
    'AA AAAC ', '000000000000',
  ].join(FS);
  client.write(encodeLength(Buffer.from(stage1Req, 'latin1')));
  await new Promise((resolve) => { const t = setInterval(() => { if (replies.length >= 1) { clearInterval(t); resolve(); } }, 10); });

  const f1 = replies[0].split(FS);
  assert.strictEqual(f1[3], '503'); // 快捷取款专属阶段确认，不是 547
  assert.strictEqual(f1[4], '');

  const stage2Req = [
    '11', 'CUB', '', '', '18', ';461760XXXXXX7710=XXXXXXXXXXXXXXXXXXXX?', '',
    'AA CAAC ', '000000010000', // 100.00
  ].join(FS);
  client.write(encodeLength(Buffer.from(stage2Req, 'latin1')));
  await new Promise((resolve) => { const t = setInterval(() => { if (replies.length >= 2) { clearInterval(t); resolve(); } }, 10); });

  const f2 = replies[1].split(FS);
  assert.strictEqual(f2[3], '128');
  assert.strictEqual(f2[4], '00010000'); // 1 x 100

  client.end();
  await new Promise((resolve) => app.server.close(resolve));
});
