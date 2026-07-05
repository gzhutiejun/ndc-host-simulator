const { buildTransactionReply } = require('../ndc/transactionReply');
const { extractRequest } = require('../ndc/transactionRequest');
const { applyReceipt, fmtDate, fmtTime, buildCam } = require('../ndc/receipt');

module.exports = function makeBalance(cfg = {}) {
  const nextState = cfg.nextState != null ? cfg.nextState : '074';
  const amount = cfg.amount != null ? cfg.amount : '5000.00';
  const returnCard = cfg.returnCard != null ? cfg.returnCard : '0';
  const printerFlag = cfg.printerFlag != null ? cfg.printerFlag : '1';
  const includeCam = cfg.includeCam === true;
  const camArc = cfg.camArc != null ? cfg.camArc : '00';
  const receipt = cfg.receipt || { screen: '', printerData: '' };

  return function balance(parsed, session, helpers) {
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
    const screen = applyReceipt(receipt.screen || '', values);
    const printer = req.mcn + returnCard + printerFlag + applyReceipt(receipt.printerData || '', values);
    const cam = buildCam(camArc, includeCam);
    return buildTransactionReply({
      luno: req.luno,
      nextState,
      fieldG: '',
      screen,
      printer,
      cam,
    });
  };
};
