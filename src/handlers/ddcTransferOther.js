const { buildDdcTransactionReply } = require('../ndc/ddcTransactionReply');
const { buildInteractiveResponse } = require('../ndc/interactiveResponse');
const { extractRequest } = require('../ndc/transactionRequest');
const { applyReceipt, fmtDate, fmtTime, DDC_PRINT_HEADER_PAD } = require('../ndc/receipt');
const { GS } = require('../constants');

const OPCODE_INDEX = 7;
const BUFFER_B_INDEX = 10;

/** 账户列表：SIM:182（GD FA C 的应答）的两个账户。key = 行号字母，ATM 回送它。 */
const DEFAULT_ACCOUNTS = [
  { key: 'I', text: '0112***80 USD' },
  { key: 'L', text: '0111***61 USD' },
];
/** SIM:182 sector 4 = `210110010000`：子类 2 + 显示 1 + 这 10 位 active keys。 */
const ACCOUNT_LIST_KEYS = '0110010000';
/** SIM:193 sector 4 = `210001110000`。 */
const CONFIRM_KEYS = '0001110000';
/** SIM 里 ITR 的 screen timer。 */
const SCREEN_TIMER = 37;

const DEFAULT_RECEIPT = '2        TRANSACTION RECEIPT<LF>          FUNDS TRANSFER<LF><LF>'
  + ' DATE          TIME<LF> <DATE>        <TIME><LF> TRANS AMOUNT  : <AMOUNT> USD<LF>'
  + ' REF           : <RECNO><LF><FF>';

function accountListScreen(accounts) {
  return '\x0c\x0c\x1bO047\x1bP0470\x1bH000\x0f@TOAR'
    + accounts.map((a) => `\x0f${a.key}1       ${a.text}-->`).join('');
}

function amountText(cents) {
  return cents == null ? '0.00' : (cents / 100).toFixed(2);
}

/** SIM:188 的 screen 形状：4 位 TSN + Z 字段（GS 分隔）+ 末段 5025。 */
function zFields(session, fields) {
  const tsn = String(session.nextTvn() % 10000).padStart(4, '0');
  return tsn + fields.map(([id, v]) => `Z000${id}${v}`).join(GS) + GS + '5025';
}

/**
 * CUBC/DDC 转他人户（GD F → GD G → GD H），一个 handler 按操作码第 4 位分段。
 *
 * 出处：CUBC_Host_Simulator/Reply/CUBC_OnusDebitCreditReply_ITR.txt 的 SIM:182-209
 * （GD FA C 账户列表 → FTOTHER1 430 → GD GA C 434 → GD HA C 确认屏 209 → FTOTHER2 130），
 * 以及 -NOITR.txt（单账户时 GD F 直接 430）。确认屏的 C/D 回送见 acc-cubc 的 cubc-itr-screen.ts。
 * GD H 收到 D 时真实主机回什么没有样本，缺省 131（官方译文表 131 = Your transaction has been cancelled）。
 */
module.exports = function makeDdcTransferOther(cfg = {}) {
  const accounts = cfg.accounts || DEFAULT_ACCOUNTS;
  const singleAccount = cfg.singleAccount === true;
  const invalidAccount = cfg.invalidAccount != null ? String(cfg.invalidAccount) : '';
  const limitCents = cfg.limitCents != null ? cfg.limitCents : null;
  const sourceAccount = cfg.sourceAccount || '01120110044380';
  const accountName = cfg.accountName || '##TITLE 1##011101102';
  const declineNextState = cfg.declineNextState || '131';
  const receipt = cfg.receipt || { printerData: DEFAULT_RECEIPT };

  return function ddcTransferOther(parsed, session, helpers) {
    const fields = parsed.fields || [];
    const opcode = fields[OPCODE_INDEX] || '';
    if (!/^GD [FGH]/.test(opcode)) return null;
    const stage = opcode.charAt(3);
    const bufferB = fields[BUFFER_B_INDEX] || '';
    const req = extractRequest(parsed);
    const reply = (nextState, screen = '', printer = '') =>
      buildDdcTransactionReply({ luno: req.luno, nextState, fieldG: '', screen, printer });
    const itr = (activeKeys, screenData) =>
      buildInteractiveResponse({ luno: req.luno, displayFlag: '1', activeKeys, screenTimer: SCREEN_TIMER, screenData });

    if (stage === 'F') {
      if (singleAccount || accounts.some((a) => a.key === bufferB)) return reply('430');
      return itr(ACCOUNT_LIST_KEYS, accountListScreen(accounts));
    }
    if (stage === 'G') {
      if (invalidAccount !== '' && bufferB === invalidAccount) return reply('149');
      return reply('434', zFields(session, [
        ['964', `${amountText(req.amount)} USD`], ['962', bufferB], ['963', accountName],
      ]));
    }
    // stage === 'H'
    if (bufferB === 'D') return reply(declineNextState);
    if (bufferB === 'C') {
      if (limitCents != null && req.amount != null && req.amount > limitCents) return reply('162');
      const now = helpers && helpers.now ? helpers.now() : new Date();
      const values = {
        date: fmtDate(now), time: fmtTime(now), recno: String(session.nextTvn()),
        luno: req.luno, amount: amountText(req.amount),
      };
      return reply('130', '', DDC_PRINT_HEADER_PAD + applyReceipt(receipt.printerData || '', values));
    }
    return itr(CONFIRM_KEYS, '\x0c\x0c\x1bO209\x1bP2090\x1bH000'
      + `\x0fHM ${sourceAccount}\x0fJM ${amountText(req.amount)} USD\x0fLM ${bufferB}  `);
  };
};

module.exports.DEFAULT_ACCOUNTS = DEFAULT_ACCOUNTS;
module.exports.accountListScreen = accountListScreen;
module.exports.zFields = zFields;
module.exports.amountText = amountText;
