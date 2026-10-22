const test = require('node:test');
const assert = require('node:assert');
const { extractRequest } = require('../src/ndc/transactionRequest');
const { parse } = require('../src/ndc/parser');
const { encodeText } = require('../src/framing');
const { FS } = require('../src/constants');

// 真实取款请求（截取 field[0..8]，PAN 掩码），来自 AJMN1301 抓包
function withdrawalReq() {
  const fields = ['11', '000', '', '', '15', ';XXXXXXXXXXXXXXXX=XXXXXXXXXXXXXXXXXXXX?', '', 'ADC     ', '00000300'];
  return parse(encodeText(fields.join(FS)));
}
// 真实余额请求（无金额，操作码 CC   C  ）
function balanceReq() {
  const fields = ['11', '000', '', '', '1=', ';XXXXXXXXXXXXXXXX=XXXXXXXXXXXX', '', 'CC   C  ', ''];
  return parse(encodeText(fields.join(FS)));
}

test('extracts amount, luno and MCN from a withdrawal request', () => {
  const r = extractRequest(withdrawalReq());
  assert.strictEqual(r.amount, 300);
  assert.strictEqual(r.luno, '000');
  assert.strictEqual(r.mcn, '5'); // field[4]='15' → 第2字符 '5'
});

test('balance request has null amount (empty field[8])', () => {
  const r = extractRequest(balanceReq());
  assert.strictEqual(r.amount, null);
});

test('respects a custom amountFieldIndex', () => {
  const p = parse(encodeText(['11', '000', '', '', '19', 'x', 'x', 'x', 'x', '00000750'].join(FS)));
  const r = extractRequest(p, { amountFieldIndex: 9 });
  assert.strictEqual(r.amount, 750);
  assert.strictEqual(r.mcn, '9');
});

// Last Transaction Status：Buffer C（段 11）之后、段首为 "2" 的段 = "2" + TSN(4) + 状态(1) + 4×5 位出钞张数。
function ltsReq(extra) {
  const fields = ['11', '000', '', '', '17', ';X=X?', '', 'A A  A A', '00010000', '', '', '', ...extra];
  return parse(encodeText(fields.join(FS)));
}

test('lts: 26 字符 2 段解析成 tsn / status / dispensed / raw', () => {
  const seg = '2' + '0042' + '1' + '00001' + '00002' + '00000' + '00010'; // 26 字符
  assert.strictEqual(seg.length, 26);
  const r = extractRequest(ltsReq(['', seg]));
  assert.deepStrictEqual(r.lts, { tsn: '0042', status: 1, dispensed: [1, 2, 0, 10], raw: seg });
});

test('lts: 没有 2 段（含 Buffer C 之后只有 CAM 5 段）时为 undefined', () => {
  assert.strictEqual(extractRequest(ltsReq([])).lts, undefined);
  assert.strictEqual(extractRequest(ltsReq(['', '5CAMDATA'])).lts, undefined);
  assert.strictEqual(extractRequest(withdrawalReq()).lts, undefined);
});

test('lts: 段 11 及之前以 2 开头的段（Buffer B / C）不算', () => {
  const fields = ['11', '000', '', '', '17', ';X=X?', '', 'A A  A A', '00010000', '', '2' + '0'.repeat(25), '2' + '0'.repeat(25)];
  assert.strictEqual(extractRequest(parse(encodeText(fields.join(FS)))).lts, undefined);
});

test('lts: 51 字符（有 BNA）同样只取前 26 字符的 tsn / status / 4 段', () => {
  const seg = '2' + '0007' + '3' + '00000'.repeat(4) + '0'.repeat(25);
  const r = extractRequest(ltsReq(['', seg]));
  assert.strictEqual(r.lts.tsn, '0007');
  assert.strictEqual(r.lts.status, 3);
  assert.deepStrictEqual(r.lts.dispensed, [0, 0, 0, 0]);
  assert.strictEqual(r.lts.raw, seg);
});

test('cam: 解出标志与 TLV；无 5 段为 undefined', () => {
  const GS = '\x1d';
  assert.strictEqual(extractRequest(withdrawalReq()).cam, undefined);
  const r = extractRequest(ltsReq(['', '5CAM0004' + '9F270180' + '9F36020001' + '5F2A020710' + '82021980']));
  assert.strictEqual(r.cam.flags, '0004');
  assert.deepStrictEqual(r.cam.tlv, [
    { tag: '9F27', len: 1, value: '80' },
    { tag: '9F36', len: 2, value: '0001' },
    { tag: '5F2A', len: 2, value: '0710' },
    { tag: '82', len: 2, value: '1980' },
  ]);
  void GS;
});

test('lts.camTail: 2 段 GS 之后的原文；没有 GS 则无此键', () => {
  const GS = '\x1d';
  const seg = '2' + '0042' + '1' + '00001' + '00002' + '00000' + '00010';
  const tail = 'CAM' + GS + '9F270180' + GS + '209F180400000001';
  assert.strictEqual(extractRequest(ltsReq(['', seg + GS + tail])).lts.camTail, tail);
  assert.ok(!('camTail' in extractRequest(ltsReq(['', seg])).lts));
});
