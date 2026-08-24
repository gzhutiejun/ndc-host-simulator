const { buildDdcTransactionReply, buildDdcEmvSegment } = require('../ndc/ddcTransactionReply');

/**
 * CUBC/DDC 的主机 PIN 验证（`HHH` 请求）。
 *
 * 这是本行卡会话的**第一条**主机报文：插卡、选语言、输 PIN 之后，主菜单之前，
 * 先发一条 `HHH` 请求验证卡号+PIN，不动钱、不出钞、不打真实凭条——真实抓包里
 * 211/213 次这一步 `ReceiptRequested=false`，屏幕只停在 PLEASE_WAIT。
 * next-state `803` = "这一段过了，继续"（对应 acc-cubc 的 `NextAction.continueDialogue`）。
 *
 * 本模拟器没有真实卡库，所以**恒批准**——测的是 ATM 侧对 803 的处理，不是主机侧
 * 的真实风控。要模拟拒绝（833 强制改密 / 804 重输 PIN），把 `nextState` 配成那个值
 * 即可，不需要额外的判断逻辑。
 */
module.exports = function makeDdcPinValidation(cfg = {}) {
  const nextState = cfg.nextState != null ? cfg.nextState : '803';
  const screen = cfg.screen != null ? cfg.screen : '';
  const printer = cfg.printer != null ? cfg.printer : '';
  const includeCam = cfg.includeCam === true;
  const camArc = cfg.camArc != null ? cfg.camArc : '00';

  return function ddcPinValidation(parsed) {
    return buildDdcTransactionReply({
      luno: parsed.luno,
      nextState,
      fieldG: '',
      screen,
      printer,
      cam: buildDdcEmvSegment(camArc, includeCam),
    });
  };
};
