const C = require('../constants');

function fmtAmount(n) {
  return n.toFixed(2);
}
function pad2(n) {
  return String(n).padStart(2, '0');
}
function fmtDate(d) {
  return `${pad2(d.getUTCDate())}/${pad2(d.getUTCMonth() + 1)}/${String(d.getUTCFullYear()).slice(-2)}`;
}
function fmtTime(d) {
  return `${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())}`;
}

/**
 * Track 2（`;4617601234567710=2512…?`）里的卡号，按现网凭条掩码：前 6 后 4，中间 X
 * （`461760XXXXXX7710`）。取不出卡号时回空串。
 */
function maskCard(track2) {
  const m = /^;?(\d{10,19})/.exec(String(track2 || ''));
  if (!m) return '';
  const pan = m[1];
  return pan.slice(0, 6) + 'X'.repeat(pan.length - 10) + pan.slice(-4);
}

function applyReceipt(tpl, values = {}) {
  const v = (x) => (x != null ? x : '');
  return String(tpl)
    .replace(/<LF>/g, '\x0a')
    .replace(/<FF>/g, '\x0c')
    .replace(/<ESC>/g, '\x1b')
    .replace(/<SO>/g, C.SO)
    .replace(/<SI>/g, C.SI)
    .replace(/<GS>/g, C.GS)
    .replace(/<AMOUNT>/g, v(values.amount))
    .replace(/<BALANCE>/g, v(values.balance))
    .replace(/<LEDGER>/g, v(values.ledger))
    .replace(/<CCY>/g, v(values.currency))
    .replace(/<CARD>/g, v(values.card))
    .replace(/<PAN>/g, v(values.pan))
    .replace(/<DATE>/g, v(values.date))
    .replace(/<TIME>/g, v(values.time))
    .replace(/<RECNO>/g, v(values.recno))
    .replace(/<LUNO>/g, v(values.luno));
}

/**
 * DDC 打印字段开头的 2 个占位字符（o+p，MCN/收卡标志）——真实主机应答里这两个字符
 * 的值从未被 acc-cubc 读取（`extract-print-data.ts` 只用它们占位，第 3 个字符才是
 * 真正读取的打印标志 q），值本身不重要，重要的是**必须占满 2 个字符**：真实应答
 * 样本证实了这一点，见下方 DDC_PRINT_FLAG 的出处说明。
 */
const DDC_PRINT_HEADER_PAD = '00';

/**
 * DDC 打印字段的打印标志（3 字符头里的 q，紧跟 DDC_PRINT_HEADER_PAD 之后，直接
 * 加在打印正文前面——**没有 GS**）。出处：`CUBC_Host_Simulator/Reply/
 * CUBC_OnusDebitCreditReply_ITR.txt` 的两条真实应答样本都印证同一形状：
 * MINIITR1 记录（对账单第 2 段）打印字段是 `002<ESC>Dhead.pcx;\n  TRANSACTION
 * RECEIPT\n...`，FTOWN003 记录（转账第 2 段）打印字段是
 * `002\n  TRANSACTION RECEIPT\n...`——两条都是「00」+「2」+ 正文，正文里没有 GS。
 * 2026-08-25 发现：本仓库 ddc*Stage2.js 系列 handler 一直把 printer 字段直接设成
 * `applyReceipt(receipt.printerData, ...)`，而 printerData 模板又都以 `<GS>1` 开头——
 * 相当于在正文最前面插进一个 GS，把本该在头部第 3 位的标志位挤到了正文里，
 * acc-cubc 那边解出来的头部第 3 位变成一个空格，判成"不认识的打印标志"，
 * 整段打印内容被丢弃（不影响交易本身成败，只丢打印/回执文本）。同时模板写的
 * 标志字符是 "1"（journalOnly，只进电子日志），而真实样本是 "2"
 * （receiptOnly）——即使头部字符数对了，用 "1" 也只会进日志、收据打印机拿不到内容。
 * 这个常量与下面的 `DDC_PRINT_FLAG.receiptOnly` 就是这两处一起修的锚点。
 */
const DDC_PRINT_FLAG = { receiptOnly: '2' };

function arcToHex(arc) {
  return [...String(arc)].map((ch) => ch.charCodeAt(0).toString(16).padStart(2, '0')).join('');
}

function buildCam(arc, include) {
  return include ? '5CAM8A02' + arcToHex(arc) : null;
}

module.exports = {
  maskCard,
  applyReceipt,
  fmtAmount,
  fmtDate,
  fmtTime,
  arcToHex,
  buildCam,
  DDC_PRINT_HEADER_PAD,
  DDC_PRINT_FLAG,
};
