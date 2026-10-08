const { buildDdcTransactionReply } = require('../ndc/ddcTransactionReply');
const { extractRequest } = require('../ndc/transactionRequest');
const { buildAccountListItr, DEFAULT_ACCOUNTS, DEST_ACCOUNTS } = require('../ndc/accountListItr');

const BUFFER_B_INDEX = 10;

/**
 * CUBC/DDC 转账（本人账户）的**第一段**（操作码基码 `GD B`）。
 *
 * 出处：NCR《CUBC Activate DDC EJ Reference Guide v.01.00》19 页，"Fund transfer
 * (own account) source account/s validation"；真实主机在这一步用 Interactive
 * Transaction Response 弹出账户选择菜单（screen data 是 VT100 光标定位格式，
 * 不是手续费/汇率确认用的 `;` 分隔 TAG=value 格式），本 handler **不模拟那个菜单**——
 * 直接批准并推进到第 2 段，同 `ddcBalanceStage1`/`ddcWithdrawalStage1` 的简化口径。
 * ⚠️ 需真 ATM 校准：真实流程这里会停下来等持卡人选账户 —— `accountList: true` 打开这一步
 * （src/ndc/accountListItr.js，SIM:138 的形状）。
 *
 * next-state 默认 `882`——解自随仓库分发的真实应答样本（`CUBC_Host_Simulator/
 * Reply/CUBC_OnusDebitCreditReply_ITR.txt` 的 `FTOWN002` 记录，`FTOWN002` = 官方
 * Excel 里"选完目标账户后的应答"）。不出钞（`fieldG` 空）——转账不动现金。
 */
module.exports = function makeDdcTransferOwnStage1(cfg = {}) {
  const nextState = cfg.nextState != null ? cfg.nextState : '882';
  const screen = cfg.screen != null ? cfg.screen : '';
  const printer = cfg.printer != null ? cfg.printer : '';
  // accountList：先后回源 / 目标两张账户列表 ITR（FTOWN001），都回送之后才回 882。缺省关（老口径）。
  const accountList = cfg.accountList === true;
  const accounts = cfg.accounts || DEFAULT_ACCOUNTS;
  const destAccounts = cfg.destAccounts || DEST_ACCOUNTS;

  return function ddcTransferOwnStage1(parsed, session) {
    const req = extractRequest(parsed);
    if (accountList) {
      // 样本四份都是：GD BA CC → 源账户列表（屏 647，单 FF、无 @TOAR）→ 回送 → FTOWN001 目标账户列表
      // （屏 648，一个账户）→ 回送 → FTOWN002 882。两次回送只差 Buffer B，按会话记走到哪一张。
      const bufferB = (parsed.fields || [])[BUFFER_B_INDEX] || '';
      const step = session && session.ownTransferList;
      if (!step || !accounts.concat(destAccounts).some((acc) => acc.key === bufferB)) {
        if (session) session.ownTransferList = 'source';
        return buildAccountListItr(req.luno, { screen: '647', toar: false, accounts });
      }
      if (step === 'source') {
        session.ownTransferList = 'destination';
        return buildAccountListItr(req.luno, { screen: '648', toar: false, accounts: destAccounts, activeKeys: '0100010000' });
      }
      session.ownTransferList = undefined;
    }
    return buildDdcTransactionReply({
      luno: req.luno,
      nextState,
      fieldG: '',
      screen,
      printer,
    });
  };
};
