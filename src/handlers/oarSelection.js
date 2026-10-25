const { buildInteractiveResponse } = require('../ndc/interactiveResponse');
const { buildTransactionReply } = require('../ndc/transactionReply');
const { extractRequest } = require('../ndc/transactionRequest');
const { buildCancelReply, buildScreen } = require('./replyFee');
const { rememberOriginal, isStrippedFollowUp, rehydrate, clearOriginal } = require('../ndc/followUp');

/** Buffer B 在段 10；opcode 在段 7。 */
const BUFFER_B_INDEX = 10;
const OPCODE_INDEX = 7;

/** ATM 回 Buffer B 的账户字母，按账户在屏上的先后顺序对位（A–D、I、H、G、F）。 */
const OAR_LETTERS = ['A', 'B', 'C', 'D', 'I', 'H', 'G', 'F'];
/** 屏幕上的键名 Account<A-H>：按顺序编号，与 Buffer B 字母是两套。 */
const SCREEN_LETTERS = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H'];
const CANCEL_KEY = 'E';
/** 交易应答模式：账户键 1..10（ATM 的账户屏最多 10 个），屏上 Account<n> 按 1 基编号。 */
const REPLY_MAX_ACCOUNTS = 10;
const REPLY_KEYS = Array.from({ length: REPLY_MAX_ACCOUNTS }, (_, i) => String(i + 1));

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
 * 存款（ATM 自己会对存款的 OAR 回 E）与改密默认不发；改密仅在 includePinChange 时发，存款仅在 includeDeposit 时发
 * （用来验 ATM 对存款 OAR 自动回 E）。
 * 账号必须是纯数字（ATM 丢弃非数字账号），名字不要含 `;`。默认 **关闭**。
 *
 * `path: "reply"`（缺省 `"itr"`，上面是 itr 的行为、字节不变）：交易应答 NS 071 / 073 的 OAR。
 *  - 首条请求：存底，回类 4 应答，NS = 转入方向 ? toNextState(073) : fromNextState(071)，FID 5 屏
 *    `Account1Number=…;Account1Name=…;…`（最多 10 个）；
 *  - 剥过字段的跟进（段 5–9 与 11 空）B ∈ 1..10：补回字段后返回 null，交给后面的规则作答；
 *  - 跟进的其余键（E 及认不出的）一律回取消应答——不能让它落到批准。
 */
module.exports = function makeOarSelection(cfg = {}) {
  const enabled = cfg.enabled === true;
  const path = cfg.path != null ? cfg.path : 'itr';
  if (path !== 'itr' && path !== 'reply') {
    throw new Error(`oarSelection: path must be "itr" or "reply", got "${path}"`);
  }
  const maxAccounts = path === 'reply' ? REPLY_MAX_ACCOUNTS : OAR_LETTERS.length;
  const accounts = Array.isArray(cfg.accounts) ? cfg.accounts.slice(0, maxAccounts) : [];
  const fromNextState = cfg.fromNextState != null ? cfg.fromNextState : '071';
  const toNextState = cfg.toNextState != null ? cfg.toNextState : '073';
  const direction = cfg.direction != null ? cfg.direction : 'from';
  const includePinChange = cfg.includePinChange === true;
  const includeDeposit = cfg.includeDeposit === true;
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
    if (isDeposit(opcode) && !includeDeposit) return null;
    if (isPinChange(opcode) && !includePinChange) return null;
    const cancel = () => buildCancelReply({
      parsed, session, helpers, nextState: cancelNextState, printer: cancelPrinter,
    });

    if (path === 'reply') {
      if (isStrippedFollowUp(parsed, session)) {
        if (REPLY_KEYS.includes(fields[BUFFER_B_INDEX] || '')) {
          rehydrate(parsed, session, 'oar');
          return null;
        }
        clearOriginal(session);
        return cancel();
      }
      rememberOriginal(session, fields);
      const req = extractRequest(parsed);
      const toward = direction === 'to' || (direction === 'auto' && isTransfer(opcode));
      const data = accounts
        .map((a, i) => `Account${i + 1}Number=${a.number};Account${i + 1}Name=${a.name}`)
        .join(';');
      return buildTransactionReply({
        luno: req.luno,
        nextState: toward ? toNextState : fromNextState,
        fieldG: '',
        screen: buildScreen(session, data),
        printer: req.mcn + '0',
      });
    }

    const bufferB = fields[BUFFER_B_INDEX] || '';
    if (OAR_LETTERS.includes(bufferB)) return null;
    if (bufferB === CANCEL_KEY) return cancel();

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

module.exports.FDK_BIT = FDK_BIT;
module.exports.isDeposit = isDeposit;
module.exports.isPinChange = isPinChange;
