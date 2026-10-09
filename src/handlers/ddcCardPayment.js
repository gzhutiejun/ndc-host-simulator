const { buildDdcTransactionReply } = require('../ndc/ddcTransactionReply');
const { buildInteractiveResponse } = require('../ndc/interactiveResponse');
const { extractRequest } = require('../ndc/transactionRequest');
const { applyReceipt, fmtDate, fmtTime, DDC_PRINT_HEADER_PAD } = require('../ndc/receipt');
const { DEFAULT_ACCOUNTS, accountListScreen, zFields, amountText } = require('./ddcTransferOther');

const OPCODE_INDEX = 7;
const BUFFER_B_INDEX = 10;
const BUFFER_C_INDEX = 11;

const DEFAULT_RECEIPT = '2        TRANSACTION RECEIPT<LF>          CREDIT PAYMENT<LF><LF>'
  + ' DATE          TIME<LF> <DATE>        <TIME><LF> CREDIT CARD  : <CARD><LF>'
  + ' TRANS AMOUNT : <AMOUNT> USD<LF> REF          : <RECNO><LF><FF>';

/** 凭条上的卡号只留后 4 位（SIM:240 `CREDIT CARD  : XXXXXXXXXXXX1509`）。 */
function maskCard(card) {
  return card.length > 4 ? 'X'.repeat(card.length - 4) + card.slice(-4) : card;
}

/**
 * CUBC/DDC 信用卡缴款（FG A → FG B → FG C → FG D），按操作码第 4 位分段。
 *
 * 出处：SIM:215-247（FG AA C 账户列表 → CRDTITR1 382 → FG BA C 385 → FG CA C 390 → FG DA C 130），
 * -NOITR.txt（单账户时 FG A 直接 382）。卡号在 Buffer C（证据 §2）。
 */
module.exports = function makeDdcCardPayment(cfg = {}) {
  const accounts = cfg.accounts || DEFAULT_ACCOUNTS;
  const singleAccount = cfg.singleAccount === true;
  const invalidCard = cfg.invalidCard != null ? String(cfg.invalidCard) : '';
  const limitCents = cfg.limitCents != null ? cfg.limitCents : null;
  const sourceAccount = cfg.sourceAccount || '01110110344901';
  const cardholderName = cfg.cardholderName || 'PHASE2-001 SV';
  const fee = cfg.fee || '0.00';
  const receiptTemplate = (cfg.receipt && cfg.receipt.printerData) || DEFAULT_RECEIPT;

  return function ddcCardPayment(parsed, session, helpers) {
    const fields = parsed.fields || [];
    const opcode = fields[OPCODE_INDEX] || '';
    if (!/^FG [ABCD]/.test(opcode)) return null;
    const stage = opcode.charAt(3);
    const bufferB = fields[BUFFER_B_INDEX] || '';
    const card = fields[BUFFER_C_INDEX] || '';
    const req = extractRequest(parsed);
    const reply = (nextState, screen = '', printer = '') =>
      buildDdcTransactionReply({ luno: req.luno, nextState, fieldG: '', screen, printer });

    if (stage === 'A') {
      // 持卡人在账户列表上取消：终端回送 Buffer B = E（参数工作簿 Exceptions OTHER EVENTS R3）。
      // 主机回什么没有样本，按官方 next state 表假设 131（Your transaction has been cancelled）。
      if (bufferB === 'E') return reply('131');
      if (singleAccount || accounts.some((a) => a.key === bufferB)) return reply('382');
      return buildInteractiveResponse({
        luno: req.luno, displayFlag: '1', activeKeys: '0110010000', screenTimer: 37,
        screenData: accountListScreen(accounts),
      });
    }
    if (stage === 'B') {
      // 无真实主机样本：按官方 next state 表假设
      if (invalidCard !== '' && card === invalidCard) return reply('149');
      return reply('385', zFields(session, [['965', card], ['963', cardholderName]]));
    }
    if (stage === 'C') {
      // 无真实主机样本：按官方 next state 表假设
      if (limitCents != null && req.amount != null && req.amount > limitCents) return reply('162');
      return reply('390', zFields(session, [
        ['964', `${amountText(req.amount)} USD`], ['965', card], ['933', `${fee} USD`],
        ['962', `${sourceAccount} USD`], ['963', cardholderName],
      ]));
    }
    // stage === 'D'
    const now = helpers && helpers.now ? helpers.now() : new Date();
    const values = {
      date: fmtDate(now), time: fmtTime(now), recno: String(session.nextTvn()),
      luno: req.luno, amount: amountText(req.amount),
    };
    const printer = applyReceipt(receiptTemplate.replace(/<CARD>/g, maskCard(card)), values);
    return reply('130', '', DDC_PRINT_HEADER_PAD + printer);
  };
};
