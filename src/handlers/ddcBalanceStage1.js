const { buildDdcTransactionReply } = require('../ndc/ddcTransactionReply');
const { extractRequest } = require('../ndc/transactionRequest');

/**
 * CUBC/DDC 余额查询的**第一段**（操作码基码 `BA A`）。
 *
 * 与取款的两段式同一条纪律（见 `ddcWithdrawalStage1.js`）：第 1 段只做准入判断，
 * 应答里没有任何业务数据，next-state `055` 表示"这一段过了，继续"。第 2 段
 * （操作码基码 `BA B`，见 `ddcBalanceStage2.js`）才带真实余额。
 *
 * 与取款的第 1 段不同的是：余额查询整个流程里客户不需要在两段之间做任何操作
 * （不用选币种/输金额）——现网抓包两段之间只出现 `PLEASE_WAIT_SCREEN`，中位间隔 4 秒，
 * 比取款的中位 12 秒短得多。这是**流程图**层面的差别，不影响这个 handler 本身。
 */
module.exports = function makeDdcBalanceStage1(cfg = {}) {
  const nextState = cfg.nextState != null ? cfg.nextState : '055';
  const screen = cfg.screen != null ? cfg.screen : '';
  const printer = cfg.printer != null ? cfg.printer : '';

  return function ddcBalanceStage1(parsed) {
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
