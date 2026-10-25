const { buildInteractiveResponse } = require('../ndc/interactiveResponse');
const { buildTransactionReply } = require('../ndc/transactionReply');
const { extractRequest } = require('../ndc/transactionRequest');
const { buildCancelReply, buildScreen } = require('./replyFee');
const { FDK_BIT, isDeposit, isPinChange } = require('./oarSelection');
const { rememberOriginal, isStrippedFollowUp, rehydrate, clearOriginal } = require('../ndc/followUp');

const OPCODE_INDEX = 7;
const BUFFER_B_INDEX = 10;
const CANCEL_KEY = 'E';

const DEFAULT_BUTTONS = [{ letter: 'A', text: 'Yes' }, { letter: 'B', text: 'No' }];

function activeKeysFor(buttons) {
  const bits = new Array(10).fill('0');
  for (const { letter } of buttons) {
    if (FDK_BIT[letter] != null) bits[FDK_BIT[letter]] = '1';
  }
  return bits.join('');
}

/**
 * 「CONDITIONAL 通用选择」的主机侧（acc-ndc-app N-13），ITR 或交易应答 NS 071 两条路径。
 *
 *  - 首条请求：存底（followUp.rememberOriginal），回 ITR（`path: "itr"`，active keys 按按钮字母开位）
 *    或类 4 应答（`path: "reply"`，NS = nextState，FID 5 屏）。屏幕数据
 *    `CONDITIONAL=<conditional>;MSG=<message>;BUTTON<x>CODE=<code>;BUTTON<x>TEXT=<text>;`
 *    （message 空不写 MSG；按钮的 code / text 定义了才写，空串也写）；
 *  - 剥过字段的跟进（段 5–9 空）B = `E`：取消应答（FID 5、NS cancelNextState、取消凭条）；
 *  - 其余跟进（按钮字母或空串）：段 5–9 补回原值后返回 null，交给后面的规则作答。
 *
 * 存款 / 改密缺省不发（includeDeposit / includePinChange）。默认 **关闭**；不要与 replyFee /
 * oarSelection 同时开（它们都匹配同一类请求，排在前面的会先答）。
 */
module.exports = function makeGenericSelection(cfg = {}) {
  const enabled = cfg.enabled === true;
  const path = cfg.path != null ? cfg.path : 'itr';
  const nextState = cfg.nextState != null ? cfg.nextState : '071';
  const conditional = cfg.conditional != null ? cfg.conditional : 'LITERAL';
  const message = cfg.message != null ? cfg.message : 'Opt in?';
  const buttons = Array.isArray(cfg.buttons) ? cfg.buttons : DEFAULT_BUTTONS;
  const screenTimer = cfg.screenTimer != null ? cfg.screenTimer : 30;
  const cancelNextState = cfg.cancelNextState != null ? cfg.cancelNextState : '048';
  const cancelPrinter = cfg.cancelPrinter != null ? cfg.cancelPrinter : 'TRANSACTION CANCELLED<LF><FF>'; // 不带 <GS>，见 replyFee.js
  const includePinChange = cfg.includePinChange === true;
  const includeDeposit = cfg.includeDeposit === true;
  if (path !== 'itr' && path !== 'reply') {
    throw new Error(`genericSelection: path must be "itr" or "reply", got "${path}"`);
  }

  const lines = ['CONDITIONAL=' + conditional];
  if (message !== '') lines.push('MSG=' + message);
  for (const button of buttons) {
    if (button.code !== undefined) lines.push(`BUTTON${button.letter}CODE=${button.code}`);
    if (button.text !== undefined) lines.push(`BUTTON${button.letter}TEXT=${button.text}`);
  }
  const data = lines.join(';');
  const activeKeys = activeKeysFor(buttons);

  return function genericSelection(parsed, session, helpers) {
    if (!enabled) return null;
    const fields = parsed.fields || [];
    const opcode = fields[OPCODE_INDEX] || '';
    if (isDeposit(opcode) && !includeDeposit) return null;
    if (isPinChange(opcode) && !includePinChange) return null;

    if (isStrippedFollowUp(parsed, session)) {
      if ((fields[BUFFER_B_INDEX] || '') === CANCEL_KEY) {
        clearOriginal(session);
        return buildCancelReply({
          parsed, session, helpers, nextState: cancelNextState, printer: cancelPrinter,
        });
      }
      rehydrate(parsed, session, 'generic');
      return null;
    }

    rememberOriginal(session, fields);
    if (path === 'reply') {
      const req = extractRequest(parsed);
      return buildTransactionReply({
        luno: req.luno,
        nextState,
        fieldG: '',
        screen: buildScreen(session, data),
        printer: req.mcn + '0',
      });
    }
    return buildInteractiveResponse({
      luno: parsed.luno,
      displayFlag: '1',
      activeKeys,
      screenTimer,
      screenData: data + ';',
    });
  };
};
