const { buildDdcTransactionReply } = require('../ndc/ddcTransactionReply');
const { extractRequest } = require('../ndc/transactionRequest');
const { applyReceipt, fmtDate, fmtTime, maskCard, DDC_PRINT_HEADER_PAD } = require('../ndc/receipt');
const { GS } = require('../constants');

/** `1266.89` → `1,266.89`（现网屏幕段带千分位）。 */
function withCommas(amount) {
  const [int, frac] = String(amount).split('.');
  return int.replace(/\B(?=(\d{3})+(?!\d))/g, ',') + (frac != null ? `.${frac}` : '');
}

/**
 * CUBC/DDC 余额查询的**第二段**（操作码基码 `BA B`）。主机上一条应答的 `055`（见
 * `ddcBalanceStage1.js`）确认过第 1 段之后，ATM 才发这一条；这条才带真实余额。
 *
 * 本模拟器没有真实账务系统，余额是**配置里的固定值**（同标准 NDC 的 `balance` 块），
 * 不出钞（`fieldG` 空），next-state 默认 `063`。
 *
 * 没配屏幕模板时，屏幕段按现网形状给：`<TSN>;<GS>Z000930<可用> USD<GS>Z000931<账面> USD<GS>5025`
 * （现网 063 共 30 条，930 = ACCT AVAILABLE BALANCE、931 = ACCT LEDGER BALANCE，取自同一条应答的凭条）。
 */
module.exports = function makeDdcBalanceStage2(cfg = {}) {
  const nextState = cfg.nextState != null ? cfg.nextState : '063';
  const amount = cfg.amount != null ? cfg.amount : '5000.00';
  const ledgerAmount = cfg.ledgerAmount != null ? cfg.ledgerAmount : amount;
  const currency = cfg.currency || 'USD';
  const receipt = cfg.receipt || { screen: '', printerData: '' };

  return function ddcBalanceStage2(parsed, session, helpers) {
    const req = extractRequest(parsed);
    const now = helpers.now ? helpers.now() : new Date();
    const values = {
      ledger: ledgerAmount,
      currency,
      card: maskCard(parsed.fields[5]),
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
      screen: receipt.screen
        ? applyReceipt(receipt.screen, values)
        : `${String(session.tvn % 10000).padStart(4, '0')};${GS}Z000930${withCommas(amount)} ${currency}`
          + `${GS}Z000931${withCommas(ledgerAmount)} ${currency}${GS}5025`,
      printer: DDC_PRINT_HEADER_PAD + applyReceipt(receipt.printerData || '', values),
    });
  };
};
