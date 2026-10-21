const { buildTransactionReply } = require('../ndc/transactionReply');
const { extractRequest } = require('../ndc/transactionRequest');

/** opcode 在段 7；手续费同意位是第 7 位（下标 6）。 */
const OPCODE_INDEX = 7;
const FEE_POSITION_INDEX = 6;

const DEFAULT_CANCEL_PRINTER = '<GS>1  TRANSACTION CANCELLED<LF>  FEE DECLINED<LF><FF>';

/**
 * 屏幕段 = TSN(4) + FID(1) + 屏号(3) + 屏幕数据（reply-disposition 取下标 4 为 FID）。
 * FID 固定 5（Set next state and print）：ATM 对取消请求的应答只认不动介质的 FID，
 * 媒体 FID 会被当成非法应答拒掉。屏幕数据以 `;` 分行，`Fee=` 必须独占一行
 * （ATM 的 parseFeeAmount 按行取）。
 */
function buildScreen(session, data) {
  const tvn = session && typeof session.nextTvn === 'function' ? session.nextTvn() : 1;
  return String(tvn % 10000).padStart(4, '0') + '5' + '000' + (data ? ';' + data + ';' : '');
}

/**
 * 取消应答（拒付取消 / OAR 取消共用）：FID 5、给定 NS、可选凭条，MCN 回显。
 */
function buildCancelReply({ parsed, session, helpers, nextState, printer }) {
  const req = extractRequest(parsed);
  const text = helpers && helpers.applyTemplate ? helpers.applyTemplate(printer, {}) : printer;
  return buildTransactionReply({
    luno: req.luno,
    nextState,
    fieldG: '',
    screen: buildScreen(session, ''),
    printer: req.mcn + '0' + '1' + text,
  });
}

/**
 * 「交易应答里带手续费」的主机侧（ATM 的 ndcFeeAcceptanceInOpcode 路径）。
 *
 * 靠 opcode 第 7 位区分三态：
 *  - 空格：首条请求，回 class 4 应答，NS=nextState、屏 `Fee=<fee>`，ATM 据此弹手续费确认；
 *  - `A` / `C`：持卡人接受后的重发，返回 null 交给后面的规则（报文库 / 取款）去答真正的交易应答；
 *  - `B` / `D`：持卡人拒付后的取消请求，回 NS=cancelReplyNextState + 取消凭条；
 *    `noReplyToCancel` 为 true 时不应答（用来测 ATM 的取消应答超时）。
 *
 * 默认 **关闭**（enabled 不为 true 时恒返回 null）。规则必须排在 opcode-library 之前，否则位 7 = B
 * 的取款请求会落到 withdrawal-request 拿到批准出钞。
 */
module.exports = function makeReplyFee(cfg = {}) {
  const enabled = cfg.enabled === true;
  const nextState = cfg.nextState != null ? cfg.nextState : '008';
  const fee = cfg.fee != null ? cfg.fee : '$2.00';
  const cancelReplyNextState = cfg.cancelReplyNextState != null ? cfg.cancelReplyNextState : '048';
  const noReplyToCancel = cfg.noReplyToCancel === true;
  const cancelPrinter = cfg.cancelPrinter != null ? cfg.cancelPrinter : DEFAULT_CANCEL_PRINTER;

  return function replyFee(parsed, session, helpers) {
    if (!enabled) return null;
    const opcode = (parsed.fields || [])[OPCODE_INDEX] || '';
    const flag = opcode[FEE_POSITION_INDEX];

    if (flag === ' ') {
      const req = extractRequest(parsed);
      return buildTransactionReply({
        luno: req.luno,
        nextState,
        fieldG: '',
        screen: buildScreen(session, 'Fee=' + fee),
        printer: req.mcn + '0',
      });
    }
    if (flag === 'B' || flag === 'D') {
      if (noReplyToCancel) return null;
      return buildCancelReply({
        parsed, session, helpers, nextState: cancelReplyNextState, printer: cancelPrinter,
      });
    }
    return null;
  };
};

module.exports.buildCancelReply = buildCancelReply;
