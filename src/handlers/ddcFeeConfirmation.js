const { buildDdcTransactionReply } = require('../ndc/ddcTransactionReply');
const { buildInteractiveResponse } = require('../ndc/interactiveResponse');
const { extractRequest } = require('../ndc/transactionRequest');
const { GS } = require('../constants');

const BUFFER_B_INDEX = 10;

/**
 * CUBC 的手续费确认：主机对一条交易请求回 ITR，屏幕数据末尾 `I=<手续费>`，终端回送 Buffer B
 * `C`（接受）或 `D`（拒绝）。现网（终端 008823）国际卡取款 AA?D 17 次：
 * ```
 * H->A 30 … 210001110000 037 <FF><FF><ESC>O111<ESC>P1110<ESC>H000<SI>I=24000.00
 * A->H 11 … C → H->A 40 … 128（出钞）        16 次
 * A->H 11 … D → H->A 40 … 131 …Z000933<fee>  1 次（2024-02-25 15:05:14）
 * ```
 * 接受之后交给 `onAccept`（国际卡：本行第 2 段的出钞 / 余额 handler；他行 CSS 卡手续费段：
 * 回阶段确认）。
 */
module.exports = function makeDdcFeeConfirmation(cfg = {}) {
  const fee = cfg.fee != null ? String(cfg.fee) : '1.00';
  const declineNextState = cfg.declineNextState != null ? cfg.declineNextState : '131';
  const activeKeys = cfg.activeKeys || '0001110000';
  const screenTimer = cfg.screenTimer != null ? cfg.screenTimer : 37;
  const onAccept = cfg.onAccept;

  return function ddcFeeConfirmation(parsed, session, helpers) {
    const bufferB = (parsed.fields || [])[BUFFER_B_INDEX] || '';
    const req = extractRequest(parsed);
    if (bufferB === 'C') return onAccept ? onAccept(parsed, session, helpers) : null;
    if (bufferB === 'D') {
      const tsn = String(session.nextTvn() % 10000).padStart(4, '0');
      return buildDdcTransactionReply({
        luno: req.luno, nextState: declineNextState, fieldG: '',
        screen: `${tsn};${GS}Z000933${fee}${GS}5025`, printer: '',
      });
    }
    return buildInteractiveResponse({
      luno: req.luno, displayFlag: '1', activeKeys, screenTimer,
      screenData: `\x0c\x0c\x1bO111\x1bP1110\x1bH000\x0fI=${fee}`,
    });
  };
};
