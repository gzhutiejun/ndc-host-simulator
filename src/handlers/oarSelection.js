const { buildInteractiveResponse } = require('../ndc/interactiveResponse');
const { buildCancelReply } = require('./replyFee');

/** Buffer B 在段 10；opcode 在段 7。 */
const BUFFER_B_INDEX = 10;
const OPCODE_INDEX = 7;

/** ATM 回 Buffer B 的账户字母，按账户在屏上的先后顺序对位（A–D、I、H、G、F）。 */
const OAR_LETTERS = ['A', 'B', 'C', 'D', 'I', 'H', 'G', 'F'];
/** 屏幕上的键名 Account<A-H>：按顺序编号，与 Buffer B 字母是两套。 */
const SCREEN_LETTERS = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H'];
const CANCEL_KEY = 'E';

/**
 * active keys 位图（手册 B006-6180 p.10-90，见 hostConfirmation.js 注释）：第 1 位数字键，
 * 第 2–10 位依次 FDK A B C D E(Cancel) F G H I。账户键按 OAR_LETTERS 前 n 个开；取消键 E 不开
 * （与设计一致：两个账户 -> 0110000000）。
 */
const FDK_BIT = { A: 1, B: 2, C: 3, D: 4, E: 5, F: 6, G: 7, H: 8, I: 9 };
function activeKeysFor(count) {
  const bits = new Array(10).fill('0');
  for (const letter of OAR_LETTERS.slice(0, count)) bits[FDK_BIT[letter]] = '1';
  return bits.join('');
}

// ndc-opcodes.json 的交易码（位 1-2）：转账 D / 本人互转 D / 电子支付 GC，改密 ID，存款 BA / BB。
const isTransfer = (opcode) => opcode.startsWith('D') || opcode.startsWith('GC');
const isPinChange = (opcode) => opcode.startsWith('ID');
const isDeposit = (opcode) => opcode.startsWith('BA') || opcode.startsWith('BB');

/**
 * 「让持卡人从主机给的账户里选一个」（OAR）的主机侧，AE 键值方言。
 *
 *  - 首条请求（Buffer B 既不是账户字母也不是 E）：回 ITR，屏
 *    `FROM;AccountANumber=…;AccountAName=…;…`（direction auto 下转账 opcode 用 `TO;`）；
 *  - Buffer B 是 A B C D I H G F 之一：持卡人选了，返回 null 放行给后面的规则。字母表内的字母
 *    一律放行，不校验是否越过账户数——不然越界字母会变成重问，ATM 与模拟器对着转圈；
 *  - Buffer B = E：持卡人取消，回取消应答（FID 5、NS 048、凭条 TRANSACTION CANCELLED）。
 *
 * 存款（ATM 自己会对存款的 OAR 回 E）与改密默认不发；改密仅在 includePinChange 时发。
 * 账号必须是纯数字（ATM 丢弃非数字账号），名字不要含 `;`。默认 **关闭**。
 */
module.exports = function makeOarSelection(cfg = {}) {
  const enabled = cfg.enabled === true;
  const accounts = Array.isArray(cfg.accounts) ? cfg.accounts.slice(0, OAR_LETTERS.length) : [];
  const direction = cfg.direction != null ? cfg.direction : 'from';
  const includePinChange = cfg.includePinChange === true;
  const cancelNextState = cfg.cancelNextState != null ? cfg.cancelNextState : '048';
  const cancelPrinter = cfg.cancelPrinter != null ? cfg.cancelPrinter : 'TRANSACTION CANCELLED<LF><FF>'; // 不带 <GS>，见 replyFee.js DEFAULT_CANCEL_PRINTER
  const screenTimer = cfg.screenTimer != null ? cfg.screenTimer : 30;
  if (enabled && accounts.length === 0) {
    throw new Error('oarSelection: accounts must be a non-empty array of { number, name }');
  }

  return function oarSelection(parsed, session, helpers) {
    if (!enabled) return null;
    const fields = parsed.fields || [];
    const opcode = fields[OPCODE_INDEX] || '';
    if (isDeposit(opcode)) return null;
    if (isPinChange(opcode) && !includePinChange) return null;

    const bufferB = fields[BUFFER_B_INDEX] || '';
    if (OAR_LETTERS.includes(bufferB)) return null;
    if (bufferB === CANCEL_KEY) {
      return buildCancelReply({
        parsed, session, helpers, nextState: cancelNextState, printer: cancelPrinter,
      });
    }

    const toward = direction === 'to' || (direction === 'auto' && isTransfer(opcode));
    const lines = [toward ? 'TO' : 'FROM'];
    accounts.forEach((account, i) => {
      lines.push(`Account${SCREEN_LETTERS[i]}Number=${account.number}`);
      lines.push(`Account${SCREEN_LETTERS[i]}Name=${account.name}`);
    });
    return buildInteractiveResponse({
      luno: parsed.luno,
      displayFlag: '1',
      activeKeys: activeKeysFor(accounts.length),
      screenTimer,
      screenData: lines.join(';') + ';',
    });
  };
};
