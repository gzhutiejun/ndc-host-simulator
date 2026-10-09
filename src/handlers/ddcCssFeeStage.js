const { buildDdcTransactionReply } = require('../ndc/ddcTransactionReply');
const { extractRequest } = require('../ndc/transactionRequest');
const { GS } = require('../constants');

const OPCODE_INDEX = 7;

/**
 * CUBC 他行 CSS 卡的**手续费段**（AA F / BA C / CA D / BB F）。主机回**普通交易应答**（不是 ITR）：
 * next state 是本族的阶段码（取款 551、余额 071、对账单 089、改密 102），屏幕段带 `Z000933<手续费>`
 * 和一个空的 `Z000962`；终端本地显示手续费，持卡人确认后发授权段（AA G / BA D / CA C / BB D）。
 *
 * 出处：Diebold 测试机 trace（终端 CUBC8807，2020-08，`AAFF` → 551 ×8，`Z0009330.45 USD`；
 * `BAFC` → 071、`CAFD` → 089、`BB F` → 102，`Z000933500.00 KHR`），参数工作簿 Them-On-Us NBC。
 * 见 acc-cubc docs/cubc/reference/archives-and-logs.md §3.3。
 *
 * 手续费币种取操作码位 6（A = USD、B = KHR）。
 */
module.exports = function makeDdcCssFeeStage(cfg = {}) {
  const nextState = cfg.nextState;
  const fee = cfg.fee != null ? String(cfg.fee) : '0.45';

  return function ddcCssFeeStage(parsed, session) {
    const req = extractRequest(parsed);
    const opcode = (parsed.fields || [])[OPCODE_INDEX] || '';
    const currency = opcode.charAt(5) === 'B' ? 'KHR' : 'USD';
    const tsn = String(session.nextTvn() % 10000).padStart(4, '0');
    return buildDdcTransactionReply({
      luno: req.luno,
      nextState,
      fieldG: '',
      screen: `${tsn};${GS}Z000933${fee} ${currency}${GS}Z000962${GS}5025`,
      printer: '',
    });
  };
};
