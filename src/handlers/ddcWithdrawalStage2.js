const { breakdown } = require('../dispense');
const { buildDdcTransactionReply, buildDdcEmvSegment } = require('../ndc/ddcTransactionReply');
const { extractRequest } = require('../ndc/transactionRequest');
const { applyReceipt, fmtDate, fmtTime, DDC_PRINT_HEADER_PAD } = require('../ndc/receipt');

/**
 * CUBC/DDC 取款的**第二段**（操作码基码 `AA C`）。主机上一条应答的 `547`（见
 * `ddcWithdrawalStage1.js`）确认过第 1 段之后，ATM 才发这一条，带真实金额、真的出钞。
 *
 * **金额字段是 12 位、单位是分**——与标准 NDC `withdrawal.js` 的 8 位字段不同，
 * 后两位不是整钞单位。出处：acc-cubc 的 `core/request/ddc-amount.ts`（位宽按方言定：
 * 标准 NDC 8 位、CUBC/DDC 12 位，小数位都是两位）。`withdrawal.js` 把 8 位字段当成
 * 整数直接配 cassette 面额，是那个 handler 自己的既有简化，DDC 这边不跟——这个 handler
 * 存在的目的就是配合真实 acc-cubc ATM 测试，金额换算必须跟 ATM 侧一致。
 */
module.exports = function makeDdcWithdrawalStage2(cfg = {}) {
  const cassettes = cfg.cassettes || [50, 100, 500, 1000];
  const amountFieldIndex = cfg.amountFieldIndex != null ? cfg.amountFieldIndex : 8;
  const approvedNextState = cfg.approvedNextState != null ? cfg.approvedNextState : '128';
  const declineNextState = cfg.declineNextState != null ? cfg.declineNextState : '048';
  const maxAmount = cfg.maxAmount != null ? cfg.maxAmount : null;
  const receipt = cfg.receipt || { screen: '', printerData: '' };
  const declineReceipt = cfg.declineReceipt || { screen: '', printerData: '' };
  const includeCam = cfg.includeCam === true;
  const camArc = cfg.camArc != null ? cfg.camArc : '00';

  return function ddcWithdrawalStage2(parsed, session, helpers) {
    const req = extractRequest(parsed, { amountFieldIndex });
    if (req.amount == null) return null;
    const amount = req.amount / 100; // 分 -> 元/主币种单位，与 cassette 面额同一量纲

    const now = helpers.now ? helpers.now() : new Date();
    const values = {
      amount: amount.toFixed(2),
      pan: req.panMasked,
      date: fmtDate(now),
      time: fmtTime(now),
      recno: String(session.nextTvn()),
      luno: req.luno,
    };

    const disp = breakdown(amount, cassettes);
    const declined = (maxAmount != null && amount > maxAmount) || !disp.ok;

    if (declined) {
      return buildDdcTransactionReply({
        luno: req.luno,
        nextState: declineNextState,
        fieldG: '',
        screen: applyReceipt(declineReceipt.screen || '', values),
        printer: DDC_PRINT_HEADER_PAD + applyReceipt(declineReceipt.printerData || '', values),
      });
    }

    return buildDdcTransactionReply({
      luno: req.luno,
      nextState: approvedNextState,
      fieldG: disp.fieldG,
      screen: applyReceipt(receipt.screen || '', values),
      printer: DDC_PRINT_HEADER_PAD + applyReceipt(receipt.printerData || '', values),
      cam: buildDdcEmvSegment(camArc, includeCam),
    });
  };
};
