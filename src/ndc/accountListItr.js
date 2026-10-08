const { buildInteractiveResponse } = require('./interactiveResponse');

/**
 * CUBC 本行卡第 1 段的账户列表 ITR。形状全部取自 CUBC_Host_Simulator/Reply 的四份样本
 * （OnusDebitCredit / OnusNBC 的 _ITR 与 -NOITR）：
 * - 余额 BA A / 取款 AA B / 快捷取款 AA A：屏 647，FF FF + `@TOAR` 行（只在 _ITR，即多账户客户）；
 * - 对账单 CA A：屏 047，FF FF + `@TOAR`（只在 _ITR）；
 * - 本人转账 GD B：屏 647，单个 FF、没有 `@TOAR`（四份都有）；接着 FTOWN001：屏 648、只有一个账户、
 *   active keys `0100010000`。
 * 行格式 `<行号字母>1       <掩码账号> <币种>-->`，ATM 回送行号字母（Buffer B）。
 */
const DEFAULT_ACCOUNTS = [
  { key: 'I', text: '0112***80 USD' },
  { key: 'L', text: '0111***61 USD' },
];
const DEST_ACCOUNTS = [{ key: 'I', text: '0111***61 USD' }];

function buildAccountListItr(luno, { screen = '647', toar = true, accounts = DEFAULT_ACCOUNTS, activeKeys = '0110010000' } = {}) {
  return buildInteractiveResponse({
    luno,
    displayFlag: '1',
    activeKeys,
    screenTimer: 37,
    screenData: (toar ? '\x0c\x0c' : '\x0c') + `\x1bO${screen}\x1bP${screen}0\x1bH000`
      + (toar ? '\x0f@TOAR' : '') + accounts.map((a) => `\x0f${a.key}1       ${a.text}-->`).join(''),
  });
}

/** 有 accountList 开关的第 1 段共用：Buffer B 不是列表里的键就回账户列表，是就放行（返回 null）。 */
function accountListGate(parsed, luno, accounts, opts) {
  const bufferB = (parsed.fields || [])[10] || '';
  if (accounts.some((a) => a.key === bufferB)) return null;
  return buildAccountListItr(luno, { ...opts, accounts });
}

module.exports = { buildAccountListItr, accountListGate, DEFAULT_ACCOUNTS, DEST_ACCOUNTS };
