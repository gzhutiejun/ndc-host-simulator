const { buildInteractiveResponse } = require('./interactiveResponse');

/**
 * 本人转账 GD B / 对账单 CA A 第 1 段的账户列表 ITR（SIM:138，本人转账 GD BA CC 的应答）：
 * 屏 647，没有 3a 账户列表（SIM:182）那一行 `@TOAR`，行格式相同（`<行号字母>1       <掩码账号> <币种>-->`）。
 * ATM 回送行号字母（Buffer B）。对账单没有自己的样本，按同一形状假设。
 */
const DEFAULT_ACCOUNTS = [
  { key: 'I', text: '0112***80 USD' },
  { key: 'L', text: '0111***61 USD' },
];

/** SIM:138 sector 4 = `210110010000`：子类 2 + 显示 1 + 这 10 位 active keys；screen timer 037。 */
function buildAccountListItr(luno, accounts = DEFAULT_ACCOUNTS) {
  return buildInteractiveResponse({
    luno,
    displayFlag: '1',
    activeKeys: '0110010000',
    screenTimer: 37,
    screenData: '\x0c\x1bO647\x1bP6470\x1bH000' + accounts.map((a) => `\x0f${a.key}1       ${a.text}-->`).join(''),
  });
}

module.exports = { buildAccountListItr, DEFAULT_ACCOUNTS };
