const { breakdown } = require('../dispense');
const { buildTransactionReply } = require('../ndc/transactionReply');
const { extractRequest } = require('../ndc/transactionRequest');
const { applyReceipt, fmtAmount, fmtDate, fmtTime, buildCam } = require('../ndc/receipt');

module.exports = function makeWithdrawal(cfg = {}) {
  const cassettes = cfg.cassettes || [50, 100, 500, 1000];
  const approvedNextState = cfg.approvedNextState != null ? cfg.approvedNextState : '123';
  const declineNextState = cfg.declineNextState != null ? cfg.declineNextState : '048';
  const returnCard = cfg.returnCard != null ? cfg.returnCard : '0';
  const printerFlag = cfg.printerFlag != null ? cfg.printerFlag : '1';
  const amountFieldIndex = cfg.amountFieldIndex != null ? cfg.amountFieldIndex : 8;
  const maxAmount = cfg.maxAmount != null ? cfg.maxAmount : null;
  const includeCam = cfg.includeCam === true;
  const camArc = cfg.camArc != null ? cfg.camArc : '00';
  const receipt = cfg.receipt || { screen: '', printerData: '' };
  const declineReceipt = cfg.declineReceipt || { screen: '', printerData: '' };

  return function withdrawal(parsed, session, helpers) {
    const req = extractRequest(parsed, { amountFieldIndex });
    if (req.amount == null) return null;

    const now = helpers.now ? helpers.now() : new Date();
    const values = {
      amount: fmtAmount(req.amount),
      pan: req.panMasked,
      date: fmtDate(now),
      time: fmtTime(now),
      recno: String(session.nextTvn()),
      luno: req.luno,
    };

    const disp = breakdown(req.amount, cassettes);
    const declined = (maxAmount != null && req.amount > maxAmount) || !disp.ok;

    if (declined) {
      const screen = applyReceipt(declineReceipt.screen || '', values);
      const printer = req.mcn + returnCard + printerFlag + applyReceipt(declineReceipt.printerData || '', values);
      return buildTransactionReply({
        luno: req.luno,
        nextState: declineNextState,
        fieldG: '',
        screen,
        printer,
        cam: null,
      });
    }

    const screen = applyReceipt(receipt.screen || '', values);
    const printer = req.mcn + returnCard + printerFlag + applyReceipt(receipt.printerData || '', values);
    const cam = buildCam(camArc, includeCam);
    return buildTransactionReply({
      luno: req.luno,
      nextState: approvedNextState,
      fieldG: disp.fieldG,
      screen,
      printer,
      cam,
    });
  };
};
