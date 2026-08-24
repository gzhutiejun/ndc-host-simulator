const { buildDdcTransactionReply } = require('../ndc/ddcTransactionReply');
const { extractRequest } = require('../ndc/transactionRequest');

/**
 * CUBC/DDC 取款的**第一段**（操作码基码 `AA B`）。
 *
 * 现网实证（终端 008823，152 条）：第 1 段发在金额输入之前——金额字段是 12 个零，
 * 不带真实业务数据。主机这一步只做准入判断，应答 next-state `547` 表示"这一段过了，
 * 接着问客户要币种和金额"；不出钞（`fieldG` 空）。第 2 段（操作码基码 `AA C`，见
 * `ddcWithdrawalStage2.js`）才带真实金额、真的出钞。
 *
 * 本模拟器**恒批准**（第 1 段本来就没有可拒绝的业务数据），也**不看请求里的金额字段**
 * ——即便调用方塞了非零值，也当作噪声忽略，因为真实主机在这一步同样不看它。
 */
module.exports = function makeDdcWithdrawalStage1(cfg = {}) {
  const nextState = cfg.nextState != null ? cfg.nextState : '547';
  const screen = cfg.screen != null ? cfg.screen : '';
  const printer = cfg.printer != null ? cfg.printer : '';

  return function ddcWithdrawalStage1(parsed) {
    const req = extractRequest(parsed);
    return buildDdcTransactionReply({
      luno: req.luno,
      nextState,
      fieldG: '',
      screen,
      printer,
    });
  };
};
