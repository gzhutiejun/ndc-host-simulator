const test = require('node:test');
const assert = require('node:assert');
const makeTransferOwn = require('../src/handlers/ddcTransferOwnStage1');
const makeTransferOwn2 = require('../src/handlers/ddcTransferOwnStage2');
const makeMini = require('../src/handlers/ddcMiniStatementStage1');
const makeBalance = require('../src/handlers/ddcBalanceStage1');
const makeWithdrawal = require('../src/handlers/ddcWithdrawalStage1');
const { parse } = require('../src/ndc/parser');
const { encodeText } = require('../src/framing');
const { FS } = require('../src/constants');
const { createSession } = require('../src/session');

// 形状全部对照 CUBC_Host_Simulator/Reply 的 OnusDebitCredit / OnusNBC 样本（_ITR 与 -NOITR）。
function req(opcode, b = '', amount = '000000000000') {
  return parse(encodeText([
    '11', 'CUB', '', '', '17', ';422131XXXXXX7329=XXXXXXXXXXXXXXXXXXXX?', '',
    opcode, amount, ':;<=>?12', b, '',
  ].join(FS)));
}
const helpers = { now: () => new Date(Date.UTC(2026, 9, 8, 10, 0)) };
const ROWS = '\x0fI1       0112***80 USD-->\x0fL1       0111***61 USD-->';

for (const [name, make, opcode, state, screen] of [
  ['余额 BA A（BALITR01）', makeBalance, 'BA AA C ', '055', '\x0c\x0c\x1bO647\x1bP6470\x1bH000\x0f@TOAR' + ROWS],
  ['取款 AA B（WDWITR01）', makeWithdrawal, 'AA BAAC ', '547', '\x0c\x0c\x1bO647\x1bP6470\x1bH000\x0f@TOAR' + ROWS],
  ['对账单 CA A（MINIITR1）', makeMini, 'CA AA C ', '085', '\x0c\x0c\x1bO047\x1bP0470\x1bH000\x0f@TOAR' + ROWS],
]) {
  const cfg = { nextState: state };
  test(`${name}：缺省（单账户）直接回 ${state}`, () => {
    assert.strictEqual(make(cfg)(req(opcode), createSession(), helpers).split(FS)[3], state);
  });
  test(`${name}：accountList，先回账户列表 ITR`, () => {
    const f = make({ ...cfg, accountList: true })(req(opcode), createSession(), helpers).split(FS);
    assert.deepStrictEqual([f[0], f[3], f[4], f[5]], ['3', '210110010000', '037', screen]);
  });
  test(`${name}：accountList，回送 FDK 字母 → ${state}`, () => {
    const f = make({ ...cfg, accountList: true })(req(opcode, 'B'), createSession(), helpers).split(FS);
    assert.deepStrictEqual([f[0], f[3]], ['4', state]);
  });
}

test('本人转账 GD B：缺省直接 882', () => {
  assert.strictEqual(makeTransferOwn({})(req('GD BA CC'), createSession()).split(FS)[3], '882');
});

test('本人转账 GD B（accountList）：源账户列表 647 → 目标账户列表 648 → 882（FTOWN001 / FTOWN002）', () => {
  const h = makeTransferOwn({ accountList: true });
  const s = createSession();
  const first = h(req('GD BA CC'), s).split(FS);
  assert.deepStrictEqual([first[0], first[3], first[5]], ['3', '210110010000', '\x0c\x1bO647\x1bP6470\x1bH000' + ROWS]);
  const second = h(req('GD BA CC', 'B'), s).split(FS);
  assert.deepStrictEqual([second[0], second[3], second[5]],
    ['3', '210100010000', '\x0c\x1bO648\x1bP6480\x1bH000\x0fI1       0111***61 USD-->']);
  const third = h(req('GD BA CC', 'A'), s).split(FS);
  assert.deepStrictEqual([third[0], third[3]], ['4', '882']);
  // 下一笔从头开始
  assert.strictEqual(h(req('GD BA CC'), s).split(FS)[0], '3');
});

test('本人转账 GD C（confirm）：确认屏 209 → C 回 130 / D 回 131', () => {
  const h = makeTransferOwn2({ confirm: true });
  const f = h(req('GD CA C ', '', '000000000365'), createSession(), helpers).split(FS);
  assert.deepStrictEqual([f[0], f[3], f[5]],
    ['3', '210001110000', '\x0c\x0c\x1bO209\x1bP2090\x1bH000\x0fHM 01120110044380\x0fJM 3.65 USD\x0fLM 01110110343661']);
  assert.strictEqual(h(req('GD CA C ', 'C', '000000000365'), createSession(), helpers).split(FS)[3], '130');
  assert.strictEqual(h(req('GD CA C ', 'D', '000000000365'), createSession(), helpers).split(FS)[3], '131');
});

test('本人转账 GD C：缺省直接 130', () => {
  assert.strictEqual(makeTransferOwn2({})(req('GD CA C '), createSession(), helpers).split(FS)[3], '130');
});

test('账户列表上取消：回送 E → 131（假设，无样本）', () => {
  assert.strictEqual(makeBalance({ accountList: true })(req('BA AA C ', 'E'), createSession(), helpers).split(FS)[3], '131');
  const s = createSession();
  const own = makeTransferOwn({ accountList: true });
  assert.strictEqual(own(req('GD BA CC'), s).split(FS)[0], '3');
  assert.strictEqual(own(req('GD BA CC', 'E'), s).split(FS)[3], '131');
});
