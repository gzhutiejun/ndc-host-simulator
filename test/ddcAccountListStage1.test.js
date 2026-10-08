const test = require('node:test');
const assert = require('node:assert');
const makeTransferOwn = require('../src/handlers/ddcTransferOwnStage1');
const makeMini = require('../src/handlers/ddcMiniStatementStage1');
const { parse } = require('../src/ndc/parser');
const { encodeText } = require('../src/framing');
const { FS } = require('../src/constants');

// 本人转账 GD B / 对账单 CA A 的第 1 段：accountList 打开时先回账户列表 ITR（SIM:138：屏 647、
// 没有 @TOAR 行），ATM 回送行号字母（Buffer B）后才回 882 / 085。
function req(opcode, b = '') {
  return parse(encodeText([
    '11', 'CUB', '', '', '17', ';422131XXXXXX7329=XXXXXXXXXXXXXXXXXXXX?', '',
    opcode, '000000000000', ':;<=>?12', b, '',
  ].join(FS)));
}
const SIM_138 = '\x0c\x1bO647\x1bP6470\x1bH000\x0fI1       0112***80 USD-->\x0fL1       0111***61 USD-->';

for (const [name, make, opcode, state] of [
  ['本人转账 GD B', makeTransferOwn, 'GD BA CC', '882'],
  ['对账单 CA A', makeMini, 'CA AA C ', '085'],
]) {
  test(`${name}：缺省不弹账户列表，直接回 ${state}`, () => {
    assert.strictEqual(make({})(req(opcode)).split(FS)[3], state);
  });

  test(`${name}：accountList，Buffer B 空 → 账户列表 ITR（SIM:138）`, () => {
    const f = make({ accountList: true })(req(opcode)).split(FS);
    assert.strictEqual(f[0], '3');
    assert.strictEqual(f[3], '210110010000');
    assert.strictEqual(f[4], '037');
    assert.strictEqual(f[5], SIM_138);
  });

  test(`${name}：accountList，Buffer B = 账户键 → ${state}`, () => {
    const f = make({ accountList: true })(req(opcode, 'L')).split(FS);
    assert.strictEqual(f[0], '4');
    assert.strictEqual(f[3], state);
  });
}
