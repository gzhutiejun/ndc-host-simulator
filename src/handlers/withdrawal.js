const { breakdown } = require('../dispense');
const { buildTransactionReply } = require('../ndc/transactionReply');
const { extractWithdrawal } = require('../ndc/transactionRequest');
const C = require('../constants');

function fmtAmount(n) {
  return n.toFixed(2); // 300 → "300.00"
}
function pad2(n) {
  return String(n).padStart(2, '0');
}
function fmtDate(d) {
  return `${pad2(d.getUTCDate())}/${pad2(d.getUTCMonth() + 1)}/${String(d.getUTCFullYear()).slice(-2)}`;
}
function fmtTime(d) {
  return `${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())}`;
}

function applyReceipt(tpl, values) {
  return String(tpl)
    .replace(/<LF>/g, '\x0a')
    .replace(/<FF>/g, '\x0c')
    .replace(/<SO>/g, C.SO)
    .replace(/<SI>/g, C.SI)
    .replace(/<GS>/g, C.GS)
    .replace(/<FS>/g, C.FS)
    .replace(/<AMOUNT>/g, values.amount)
    .replace(/<PAN>/g, values.pan)
    .replace(/<DATE>/g, values.date)
    .replace(/<TIME>/g, values.time)
    .replace(/<RECNO>/g, values.recno)
    .replace(/<LUNO>/g, values.luno);
}

// ARC 字符串 → ASCII 十六进制（"00" → "3030"）
function arcToHex(arc) {
  return [...String(arc)].map((ch) => ch.charCodeAt(0).toString(16).padStart(2, '0')).join('');
}

module.exports = function makeWithdrawal(cfg = {}) {
  const cassettes = cfg.cassettes || [50, 100, 500, 1000];
  const approvedNextState = cfg.approvedNextState || '123';
  const returnCard = cfg.returnCard || '0';
  const printerFlag = cfg.printerFlag || '1';
  const amountFieldIndex = cfg.amountFieldIndex != null ? cfg.amountFieldIndex : 8;
  const includeCam = cfg.includeCam === true;
  const camArc = cfg.camArc || '00';
  const receipt = cfg.receipt || { screen: '', printerData: '' };

  return function withdrawal(parsed, session, helpers) {
    const req = extractWithdrawal(parsed, { amountFieldIndex });
    if (req.amount == null) return null; // 非法/缺金额 —— decline 钩子最小实现
    const disp = breakdown(req.amount, cassettes);
    if (!disp.ok) return null; // 无法出钞 —— decline 钩子最小实现

    const now = helpers.now ? helpers.now() : new Date();
    const values = {
      amount: fmtAmount(req.amount),
      pan: req.panMasked,
      date: fmtDate(now),
      time: fmtTime(now),
      recno: String(session.nextTvn()),
      luno: req.luno,
    };
    const screen = applyReceipt(receipt.screen || '', values);
    const printer = req.mcn + returnCard + printerFlag + applyReceipt(receipt.printerData || '', values);
    const cam = includeCam ? '5CAM8A02' + arcToHex(camArc) : null;

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
