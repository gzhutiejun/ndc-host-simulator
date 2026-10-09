const { buildDdcTransactionReply } = require('../ndc/ddcTransactionReply');
const { buildInteractiveResponse } = require('../ndc/interactiveResponse');
const { extractRequest } = require('../ndc/transactionRequest');
const { applyReceipt, fmtDate, fmtTime, DDC_PRINT_HEADER_PAD } = require('../ndc/receipt');
const { buildAccountListItr, isAccountKey } = require('../ndc/accountListItr');

const OPCODE_INDEX = 7;
const BUFFER_B_INDEX = 10;
const BUFFER_C_INDEX = 11;

/** Diebold trace 本行 NBC 卡 DF A 的源账户列表（屏 047，@TOAR，币种后面跟 C / S = 往来 / 储蓄）。 */
const DEFAULT_ACCOUNTS = [
  { key: 'I', text: '100*********160 USD C' },
  { key: 'L', text: '100*********051 KHR S' },
];

const DEFAULT_RECEIPT = '2        TRANSACTION RECEIPT<LF>          FUNDS TRANSFER<LF><LF>'
  + ' DATE          TIME<LF> <DATE>        <TIME><LF> BENEFICIARY  : <BANK><LF> DEST ACCT    : <ACCOUNT><LF>'
  + ' TRANS AMOUNT : <AMOUNT> <CCY><LF> FEE          : <FEE> <CCY><LF> REF          : <RECNO><LF><FF>';

/**
 * CUBC/DDC 跨行转账（DF，主机称 IBFT）。本行 NBC 卡 `DF A..G`，他行 CSS 卡 `DFF B..G`（没有 A），按操作码第 4 位分段：
 *   A 源账户列表 ITR → 回送行号 → 808；B（Buffer C = 收款行代码）→ 814；C（Buffer C = 收款账号）→ 861；
 *   D（金额）→ 820；F → 确认屏 209（受益行 / 账号 / 户名 / 金额 / 手续费）→ C → 822（D / E → 131）；G → 130（凭条）。
 * 出处：Diebold 测试机 trace（CUBC8807，2020-08-05，acc-cubc docs/cubc/reference/diebold-logs/df-interbank-raw.txt）
 * 与参数工作簿 Us-On-Us NBC R59-69。币种取操作码位 6（B = KHR）。invalidAccount 填一个收款账号时，G 段回 149。
 */
module.exports = function makeDdcInterbank(cfg = {}) {
  const accounts = cfg.accounts || DEFAULT_ACCOUNTS;
  const invalidAccount = cfg.invalidAccount != null ? String(cfg.invalidAccount) : '';
  const destName = cfg.destName || '';
  const fee = cfg.fee || { USD: '0.60', KHR: '2400.00' };
  const banks = cfg.banks || {};
  const receiptTemplate = (cfg.receipt && cfg.receipt.printerData) || DEFAULT_RECEIPT;

  return function ddcInterbank(parsed, session, helpers) {
    const fields = parsed.fields || [];
    const opcode = fields[OPCODE_INDEX] || '';
    if (!/^DF[ F][ABCDFG]/.test(opcode)) return null;
    const stage = opcode.charAt(3);
    const bufferB = fields[BUFFER_B_INDEX] || '';
    const bufferC = fields[BUFFER_C_INDEX] || '';
    const req = extractRequest(parsed);
    const currency = opcode.charAt(5) === 'B' ? 'KHR' : 'USD';
    const s = session || {};
    const reply = (nextState, printer = '') =>
      buildDdcTransactionReply({ luno: req.luno, nextState, fieldG: '', screen: '', printer });

    if (stage === 'A') {
      if (bufferB === 'E') return reply('131');
      if (isAccountKey(accounts, bufferB)) return reply('808');
      return buildAccountListItr(req.luno, { screen: '047', toar: true, accounts });
    }
    if (stage === 'B') {
      s.interbankBank = bufferC;
      return reply('814');
    }
    if (stage === 'C') {
      s.interbankAccount = bufferC;
      return reply('861');
    }
    if (stage === 'D') return reply('820');
    if (stage === 'F') {
      if (bufferB === 'C') return reply('822');
      if (bufferB === 'D' || bufferB === 'E') return reply('131');
      const amount = req.amount == null ? '0.00' : (req.amount / 100).toLocaleString('en-US', { minimumFractionDigits: 2 });
      const bank = banks[s.interbankBank] || `BANK ${s.interbankBank || ''}`.trim();
      return buildInteractiveResponse({
        luno: req.luno, displayFlag: '1', activeKeys: '0001110000', screenTimer: 37,
        screenData: '\x0c\x0c\x1bO209\x1bP2090'
          + `\x0fFA BENEFICIARY:${bank}\x0fGA DEST ACCT  :${bufferC}\x0fHA DEST NAME  :${destName}`
          + `\x0fIA AMOUNT     :${amount} ${currency}\x0fJA FEE CHARGE :${fee[currency]} ${currency}`,
      });
    }
    // stage === 'G'
    if (invalidAccount !== '' && bufferC === invalidAccount) return reply('149');
    const now = helpers && helpers.now ? helpers.now() : new Date();
    const values = {
      date: fmtDate(now), time: fmtTime(now), recno: String(s.nextTvn ? s.nextTvn() : 1), luno: req.luno,
      amount: req.amount == null ? '0.00' : (req.amount / 100).toFixed(2),
      currency,
    };
    const tpl = receiptTemplate
      .replace(/<BANK>/g, banks[s.interbankBank] || s.interbankBank || '')
      .replace(/<ACCOUNT>/g, bufferC)
      .replace(/<FEE>/g, fee[currency]);
    return reply('130', DDC_PRINT_HEADER_PAD + applyReceipt(tpl, values));
  };
};
