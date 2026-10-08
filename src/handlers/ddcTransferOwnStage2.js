const { buildDdcTransactionReply } = require('../ndc/ddcTransactionReply');
const { extractRequest } = require('../ndc/transactionRequest');
const { applyReceipt, fmtDate, fmtTime, DDC_PRINT_HEADER_PAD } = require('../ndc/receipt');
const { buildInteractiveResponse } = require('../ndc/interactiveResponse');

const BUFFER_B_INDEX = 10;

/**
 * CUBC/DDC 转账（本人账户）的**第二段**（操作码基码 `GD C`）。主机上一条应答的
 * `882`（见 `ddcTransferOwnStage1.js`）确认过第 1 段之后，ATM 才发这一条。
 *
 * 出处：NCR《CUBC Activate DDC EJ Reference Guide v.01.00》19 页，"Fund transfer
 * (own account) transaction authorization"。真实主机在这一步同样会先弹一条
 * Interactive Transaction Response 让持卡人确认金额（屏 209）—— `confirm: true` 打开这一步，
 * 缺省直接批准（老口径）。
 *
 * next-state 默认 `130`——解自真实应答样本（`FTOWN003` 记录，官方 Excel 标注为
 * "转账最终交易请求收到后的应答"）。**恒不出钞**（`fieldG` 空，无条件，不是
 * `cfg` 可配）：转账动的是账户间的钱，从不涉及现金分发，与取款/快捷取款不同。
 */
module.exports = function makeDdcTransferOwnStage2(cfg = {}) {
  const nextState = cfg.nextState != null ? cfg.nextState : '130';
  const receipt = cfg.receipt || { screen: '', printerData: '' };

  // confirm：先回确认屏 209（转出 / 金额 / 转入，样本四份的 GD CA C），回送 C 才 130，D 回 declineNextState。
  const confirm = cfg.confirm === true;
  const sourceAccount = cfg.sourceAccount || '01120110044380';
  const destAccount = cfg.destAccount || '01110110343661';
  const declineNextState = cfg.declineNextState || '131';

  return function ddcTransferOwnStage2(parsed, session, helpers) {
    const req = extractRequest(parsed);
    if (confirm) {
      const bufferB = (parsed.fields || [])[BUFFER_B_INDEX] || '';
      if (bufferB === 'D') return buildDdcTransactionReply({ luno: req.luno, nextState: declineNextState, fieldG: '', screen: '', printer: '' });
      if (bufferB !== 'C') {
        const amount = req.amount == null ? '0.00' : (req.amount / 100).toFixed(2);
        return buildInteractiveResponse({
          luno: req.luno, displayFlag: '1', activeKeys: '0001110000', screenTimer: 37,
          screenData: `\x0c\x0c\x1bO209\x1bP2090\x1bH000\x0fHM ${sourceAccount}\x0fJM ${amount} USD\x0fLM ${destAccount}`,
        });
      }
    }
    const now = helpers.now ? helpers.now() : new Date();
    const values = {
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
      screen: applyReceipt(receipt.screen || '', values),
      printer: DDC_PRINT_HEADER_PAD + applyReceipt(receipt.printerData || '', values),
    });
  };
};
