const { buildDdcTransactionReply } = require('../ndc/ddcTransactionReply');
const { extractRequest } = require('../ndc/transactionRequest');

/**
 * 只回一个 next state 的 DDC 交易应答（不出钞、不带屏幕与凭条）：阶段确认，或无凭条的结论。
 */
module.exports = function makeDdcStageReply(cfg = {}) {
  const nextState = cfg.nextState != null ? cfg.nextState : '048';
  return function ddcStageReply(parsed) {
    const req = extractRequest(parsed);
    return buildDdcTransactionReply({ luno: req.luno, nextState, fieldG: '', screen: '', printer: '' });
  };
};
