const { buildDdcTransactionReply } = require('../ndc/ddcTransactionReply');
const { extractRequest } = require('../ndc/transactionRequest');
const { applyReceipt, fmtDate, fmtTime, DDC_PRINT_HEADER_PAD } = require('../ndc/receipt');

/**
 * CUBC/DDC 余额查询的**第二段**（操作码基码 `BA B`）。主机上一条应答的 `055`（见
 * `ddcBalanceStage1.js`）确认过第 1 段之后，ATM 才发这一条；这条才带真实余额。
 *
 * 本模拟器没有真实账务系统，余额是**配置里的固定值**（同标准 NDC 的 `balance` 块），
 * 不出钞（`fieldG` 空），next-state 默认 `063`。
 */
module.exports = function makeDdcBalanceStage2(cfg = {}) {
  const nextState = cfg.nextState != null ? cfg.nextState : '063';
  const amount = cfg.amount != null ? cfg.amount : '5000.00';
  const receipt = cfg.receipt || { screen: '', printerData: '' };

  return function ddcBalanceStage2(parsed, session, helpers) {
    const req = extractRequest(parsed);
    const now = helpers.now ? helpers.now() : new Date();
    const values = {
      balance: amount,
      pan: req.panMasked,
      date: fmtDate(now),
      time: fmtTime(now),
      recno: String(session.nextTvn()),
      luno: req.luno,
    };
    return buildDdcTransactionReply({
      luno: req.luno,
      nextState,
      fieldG: '',
      screen: applyReceipt(receipt.screen || '', values),
      printer: DDC_PRINT_HEADER_PAD + applyReceipt(receipt.printerData || '', values),
    });
  };
};
