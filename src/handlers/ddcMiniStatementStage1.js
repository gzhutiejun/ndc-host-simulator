const { buildDdcTransactionReply } = require('../ndc/ddcTransactionReply');
const { extractRequest } = require('../ndc/transactionRequest');

/**
 * CUBC/DDC 对账单（Mini Statement）的**第一段**（操作码基码 `CA A`）。
 *
 * 出处：NCR《CUBC Activate DDC EJ Reference Guide v.01.00》操作码表，"Mini
 * statement source account/s validation"；真实主机在这一步用 Interactive
 * Transaction Response 弹出账户选择菜单（screen data 是 VT100 光标定位格式，
 * 同 `ddcTransferOwnStage1` 的账户选择菜单一个格式），本 handler **不模拟那个菜单**——
 * 直接批准并推进到第 2 段，同 `ddcBalanceStage1`/`ddcTransferOwnStage1` 的简化口径。
 * ⚠️ 需真 ATM 校准：真实流程这里会停下来等持卡人选账户。
 *
 * next-state 默认 `085`——解自随仓库分发的真实应答样本（`CUBC_Host_Simulator/
 * Reply/CUBC_OnusDebitCreditReply_ITR.txt` 的 `MINIITR1` 记录，紧跟在 `CA AA C`
 * 触发行之后）。不出钞（`fieldG` 空）——对账单不动现金。
 */
module.exports = function makeDdcMiniStatementStage1(cfg = {}) {
  const nextState = cfg.nextState != null ? cfg.nextState : '085';
  const screen = cfg.screen != null ? cfg.screen : '';
  const printer = cfg.printer != null ? cfg.printer : '';

  return function ddcMiniStatementStage1(parsed) {
    const req = extractRequest(parsed);
    return buildDdcTransactionReply({
      luno: req.luno,
      nextState,
      fieldG: '',
      screen,
      printer,
    });
  };
};
