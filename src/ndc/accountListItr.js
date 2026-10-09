const { buildInteractiveResponse } = require('./interactiveResponse');
const { buildDdcTransactionReply } = require('./ddcTransactionReply');

/**
 * CUBC 本行卡第 1 段的账户列表 ITR。形状全部取自 CUBC_Host_Simulator/Reply 的四份样本
 * （OnusDebitCredit / OnusNBC 的 _ITR 与 -NOITR）：
 * - 余额 BA A / 取款 AA B / 快捷取款 AA A：屏 647，FF FF + `@TOAR` 行（只在 _ITR，即多账户客户）；
 * - 对账单 CA A：屏 047，FF FF + `@TOAR`（只在 _ITR）；
 * - 本人转账 GD B：屏 647，单个 FF、没有 `@TOAR`（四份都有）；接着 FTOWN001：屏 648、只有一个账户、
 *   active keys `0100010000`。
 * 行格式 `<行号字母>1       <掩码账号> <币种>-->`。ATM 回送的不是行号字母，而是按行先后的 FDK 字母
 * A B C D F G H I（E 是取消）：旧终端应用 NCR 测试页 index.html:145-193，与 active keys 位图
 * （位 1-4 = FDK A-D、5 = 取消、6-9 = FDK F-I；两行 `0110010000` = A、B、取消）一致。
 */
const ROW_KEYS = ['A', 'B', 'C', 'D', 'F', 'G', 'H', 'I'];

/** Buffer B 是不是这张列表里某一行的 FDK 字母。 */
function isAccountKey(accounts, bufferB) {
  const i = ROW_KEYS.indexOf(bufferB);
  return i >= 0 && i < accounts.length;
}

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
  // 持卡人取消：终端回送 E（参数工作簿 Exceptions OTHER EVENTS R3）；回 131 是假设（无样本）。
  if (bufferB === 'E') {
    return buildDdcTransactionReply({ luno, nextState: '131', fieldG: '', screen: '', printer: '' });
  }
  if (isAccountKey(accounts, bufferB)) return null;
  return buildAccountListItr(luno, { ...opts, accounts });
}

module.exports = { buildAccountListItr, accountListGate, isAccountKey, ROW_KEYS, DEFAULT_ACCOUNTS, DEST_ACCOUNTS };
