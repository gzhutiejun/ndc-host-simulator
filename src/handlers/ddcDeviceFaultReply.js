const { buildDdcTransactionReply } = require('../ndc/ddcTransactionReply');
const { DDC_PRINT_HEADER_PAD } = require('../ndc/receipt');
const { GS } = require('../constants');

/**
 * CUBC/DDC：终端发出钞机设备故障（冲正，`22<FS>LUNO<FS><FS>8<FS>…`）之后，主机再回一条交易应答。
 * 照 Diebold trace（acc-cubc docs/cubc/reference/diebold-logs，2020-08-05）：
 *  - 12:35:57 部分出钞（`1b05…` 钞箱 1 出了 5 张）→ 128，不再出钞、带凭条；
 *  - 12:40:54 一张没出 → 142，凭条 `DESC: NO NOTES DISPENSED`。
 * 终端执行完回 Ready 'B'。读卡器的设备故障（`>7082` / `4081…`）没有样本，不回。
 *
 * 钞箱段：标签 1 位 + 状态字母 + 2 位张数 + `00000`（acc-cubc `cubc-d912-cash-dispenser.ts`，Diebold 同形）。
 */
const CASSETTE = /([1-4])([@A-Da-d])(\d\d)00000/g;

module.exports = function makeDdcDeviceFaultReply(cfg = {}) {
  const partialNextState = cfg.partialNextState || '128';
  const noneNextState = cfg.noneNextState || '142';
  return function ddcDeviceFaultReply(parsed, session) {
    const status = parsed.fields[4] || '';
    const segments = [...status.matchAll(CASSETTE)];
    if (segments.length === 0) return null; // 不是出钞机设备故障
    const notes = segments.reduce((n, m) => n + Number(m[3]), 0);
    const nextState = notes > 0 ? partialNextState : noneNextState;
    const tsn = String(session.tvn % 10000).padStart(4, '0');
    return buildDdcTransactionReply({
      luno: parsed.fields[1] || '',
      nextState,
      fieldG: '',
      screen: `${tsn}${GS}5025`,
      printer: DDC_PRINT_HEADER_PAD + '1' + (notes > 0 ? 'CASH WITHDRAWAL' : 'CASH WITHDRAWAL\nDESC: NO NOTES DISPENSED'),
    });
  };
};
