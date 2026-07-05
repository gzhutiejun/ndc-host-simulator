const test = require('node:test');
const assert = require('node:assert');
const { extractWithdrawal } = require('../src/ndc/transactionRequest');
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
  const r = extractWithdrawal(withdrawalReq());
  assert.strictEqual(r.amount, 300);
  assert.strictEqual(r.luno, '000');
  assert.strictEqual(r.mcn, '5'); // field[4]='15' → 第2字符 '5'
});

test('balance request has null amount (empty field[8])', () => {
  const r = extractWithdrawal(balanceReq());
  assert.strictEqual(r.amount, null);
});

test('respects a custom amountFieldIndex', () => {
  const p = parse(encodeText(['11', '000', '', '', '19', 'x', 'x', 'x', 'x', '00000750'].join(FS)));
  const r = extractWithdrawal(p, { amountFieldIndex: 9 });
  assert.strictEqual(r.amount, 750);
  assert.strictEqual(r.mcn, '9');
});
