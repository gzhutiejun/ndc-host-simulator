const test = require('node:test');
const assert = require('node:assert');
const makeDdcWithdrawalStage1 = require('../src/handlers/ddcWithdrawalStage1');
const { parse } = require('../src/ndc/parser');
const { encodeText } = require('../src/framing');
const { FS } = require('../src/constants');
const { createSession } = require('../src/session');

// 形状取自现网真实报文（终端 008823）：第 1 段不带金额（12 个零），操作码基码 "AA B"。
function stage1Req(opcode = 'AA BAAC ') {
  return parse(encodeText([
    '11', 'CUB', '', '', '17', ';461760XXXXXX7710=XXXXXXXXXXXXXXXXXXXX?', '',
    opcode, '000000000000',
  ].join(FS)));
}
const helpers = { applyTemplate: (s) => s, ctx: {}, constants: require('../src/constants'), now: () => new Date() };

test('approves stage 1: class 4, next-state 547, no dispense', () => {
  const handler = makeDdcWithdrawalStage1({});
  const out = handler(stage1Req(), createSession(), helpers);
  const f = out.split(FS);
  assert.strictEqual(f[0], '4');
  assert.strictEqual(f[1], 'CUB');
  assert.strictEqual(f[3], '547');
  assert.strictEqual(f[4], ''); // 第 1 段不出钞——金额还没定
});

test('next-state is configurable', () => {
  const handler = makeDdcWithdrawalStage1({ nextState: '140' });
  const out = handler(stage1Req(), createSession(), helpers);
  assert.strictEqual(out.split(FS)[3], '140');
});

test('ignores whatever is in the amount field — stage 1 never carries a real amount', () => {
  const handler = makeDdcWithdrawalStage1({});
  const out = handler(stage1Req('AA BAAC '), createSession(), helpers);
  assert.strictEqual(out.split(FS)[4], '');
});
