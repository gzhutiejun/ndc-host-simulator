const { buildDdcTransactionReply } = require('../ndc/ddcTransactionReply');
const { extractRequest } = require('../ndc/transactionRequest');
const { applyReceipt, fmtDate, fmtTime, DDC_PRINT_HEADER_PAD } = require('../ndc/receipt');

/**
 * CUBC/DDC 对账单（Mini Statement）的**第二段**（操作码基码 `CA B`）。主机上一条
 * 应答的 `085`（见 `ddcMiniStatementStage1.js`）确认过第 1 段之后，ATM 才发这一条，
 * 这条带真实对账单内容（真实应答样本的 `TXN TYPE: MINI STATEMENT` 印证这就是
 * 交易的结论段，不再需要更多客户操作）。
 *
 * 出处：NCR《CUBC Activate DDC EJ Reference Guide v.01.00》操作码表，"Mini
 * statement transaction authorization"。真实主机的对账单明细（近几笔交易的
 * 日期/类型/金额）来自账务系统，本模拟器没有真实账务系统、给不出来 —— 与
 * `ddcBalanceStage2` 的余额同理，回执模板留空/占位即可，不冒充具体数字。
 *
 * next-state 默认 `093`——解自真实应答样本（紧跟在 `CA BA C` 触发行之后，无独立
 * 具名记录）。**恒不出钞**（`fieldG` 空，无条件，不是 `cfg` 可配）：对账单不涉及
 * 现金分发，与取款不同。
 */
module.exports = function makeDdcMiniStatementStage2(cfg = {}) {
  const nextState = cfg.nextState != null ? cfg.nextState : '093';
  const receipt = cfg.receipt || { screen: '', printerData: '' };

  return function ddcMiniStatementStage2(parsed, session, helpers) {
    const req = extractRequest(parsed);
    const now = helpers.now ? helpers.now() : new Date();
    const values = {
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
