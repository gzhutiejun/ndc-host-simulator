const { buildDdcTransactionReply } = require('../ndc/ddcTransactionReply');
const { extractRequest } = require('../ndc/transactionRequest');
const { applyReceipt, fmtDate, fmtTime } = require('../ndc/receipt');

/**
 * CUBC/DDC 转账（本人账户）的**第二段**（操作码基码 `GD C`）。主机上一条应答的
 * `882`（见 `ddcTransferOwnStage1.js`）确认过第 1 段之后，ATM 才发这一条。
 *
 * 出处：NCR《CUBC Activate DDC EJ Reference Guide v.01.00》19 页，"Fund transfer
 * (own account) transaction authorization"。真实主机在这一步同样会先弹一条
 * Interactive Transaction Response 让持卡人确认金额，本 handler **不模拟那次确认**，
 * 直接批准——同 `ddcTransferOwnStage1.js` 的简化口径，⚠️ 需真 ATM 校准。
 *
 * next-state 默认 `130`——解自真实应答样本（`FTOWN003` 记录，官方 Excel 标注为
 * "转账最终交易请求收到后的应答"）。**恒不出钞**（`fieldG` 空，无条件，不是
 * `cfg` 可配）：转账动的是账户间的钱，从不涉及现金分发，与取款/快捷取款不同。
 */
module.exports = function makeDdcTransferOwnStage2(cfg = {}) {
  const nextState = cfg.nextState != null ? cfg.nextState : '130';
  const receipt = cfg.receipt || { screen: '', printerData: '' };

  return function ddcTransferOwnStage2(parsed, session, helpers) {
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
      printer: applyReceipt(receipt.printerData || '', values),
    });
  };
};
