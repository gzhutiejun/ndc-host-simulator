const test = require('node:test');
const assert = require('node:assert');
const makeDdcBalanceStage1 = require('../src/handlers/ddcBalanceStage1');
const { parse } = require('../src/ndc/parser');
const { encodeText } = require('../src/framing');
const { FS } = require('../src/constants');
const { createSession } = require('../src/session');

// 操作码基码 "BA A"（BalanceAuth，第 1 段）——同两段式取款，第 1 段只做准入判断，
// 没有真实业务数据。
function stage1Req(opcode = 'BA AAC ') {
  return parse(encodeText([
    '11', 'CUB', '', '', '17', ';461760XXXXXX7710=XXXXXXXXXXXXXXXXXXXX?', '',
    opcode, '',
  ].join(FS)));
}
const helpers = { applyTemplate: (s) => s, ctx: {}, constants: require('../src/constants'), now: () => new Date() };

test('approves stage 1: class 4, next-state 055, no dispense', () => {
  const handler = makeDdcBalanceStage1({});
  const out = handler(stage1Req(), createSession(), helpers);
  const f = out.split(FS);
  assert.strictEqual(f[0], '4');
  assert.strictEqual(f[1], 'CUB');
  assert.strictEqual(f[3], '055');
  assert.strictEqual(f[4], '');
});

test('next-state is configurable', () => {
  const handler = makeDdcBalanceStage1({ nextState: '140' });
  const out = handler(stage1Req(), createSession(), helpers);
  assert.strictEqual(out.split(FS)[3], '140');
});
