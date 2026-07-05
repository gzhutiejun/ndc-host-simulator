const test = require('node:test');
const assert = require('node:assert');
const { parse } = require('../src/ndc/parser');
const { FS, ETX } = require('../src/constants');
const { encodeText } = require('../src/framing');

// 来自 ATM 项目 ReadyStatusTest.cs: Ready9 solicited status
test('parses Ready9 solicited status "22<FS>123<FS><FS>9"', () => {
  const p = parse(encodeText('22' + FS + '123' + FS + FS + '9'));
  assert.strictEqual(p.messageClass, '2');
  assert.strictEqual(p.subClass, '2');
  assert.strictEqual(p.luno, '123');
  assert.deepStrictEqual(p.fields, ['22', '123', '', '9']); // 空字段被保留
  assert.strictEqual(p.type, 'SolicitedStatus');
  assert.strictEqual(p.hasETX, false);
});

// ReadyB + 真实抓包尾随数据（现有 server.js 里的 "B0000" 触发）
test('parses ReadyB solicited status with trailing data', () => {
  const p = parse(encodeText('22' + FS + '000' + FS + FS + 'B0000'));
  assert.strictEqual(p.type, 'SolicitedStatus');
  assert.strictEqual(p.fields[3], 'B0000');
});

// 来自 TransactionRequestTest.cs: transaction request 前缀 "11"
test('parses transaction request "11<FS>123<FS>..." as TransactionRequest', () => {
  const p = parse(encodeText('11' + FS + '123' + FS + FS + FS + '1'));
  assert.strictEqual(p.messageClass, '1');
  assert.strictEqual(p.subClass, '1');
  assert.strictEqual(p.type, 'TransactionRequest');
  assert.strictEqual(p.luno, '123');
});

test('detects trailing ETX', () => {
  const p = parse(encodeText('11' + FS + '123' + ETX));
  assert.strictEqual(p.hasETX, true);
});

test('unknown class falls back to Unknown type', () => {
  const p = parse(encodeText('ZZ' + FS + '123'));
  assert.strictEqual(p.type, 'Unknown');
});
