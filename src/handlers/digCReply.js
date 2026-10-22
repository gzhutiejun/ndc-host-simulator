const { buildTransactionReply } = require('../ndc/transactionReply');
const { decodeTokens } = require('../ddcDownload');
const { buildScreen } = require('./replyFee');

/**
 * 8b：ATM 因卡片层失败发 solicited DIG（字段 3 = `8`，字段 4 以 `c` 开头）后等主机新应答。
 * 回一条 class 4：MCN 0、FID 5、NS = cfg.nextState、凭条 = cfg.receipt，不带 CAM。
 * 默认关闭：enabled 不为 true 或请求不是 DIG c 时返回 null，交给后面的 status 规则。
 */
module.exports = function makeDigCReply(cfg = {}) {
  const enabled = cfg.enabled === true;
  const nextState = cfg.nextState != null ? cfg.nextState : '048';
  const receipt = cfg.receipt != null ? cfg.receipt : 'CARD DECLINED';

  return function digCReply(parsed, session) {
    if (!enabled) return null;
    const f = parsed.fields || [];
    if (parsed.messageClass !== '2' || f[3] !== '8' || !String(f[4] || '').startsWith('c')) return null;
    return buildTransactionReply({
      luno: parsed.luno,
      nextState,
      fieldG: '',
      screen: buildScreen(session, ''),
      // 与取消凭条同形：MCN(0) + 0 + 打印标志 3（凭条 + 日志）+ 正文。
      printer: '0' + '0' + '3' + decodeTokens(receipt),
    });
  };
};
