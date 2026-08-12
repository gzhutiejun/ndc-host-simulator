const { FS } = require('../constants');

/**
 * Interactive Transaction Response（消息类 `3`、子类 `2`）。
 *
 * 主机用它在**记账之前**先让持卡人确认一件事——手续费、汇率/DCC 都走这条报文。ATM 显示
 * 屏幕文本、收一个功能键，然后**重发一条 Transaction Request**，把按键放进 Buffer B；
 * 主机收到那一条才做账务处理，再回 Transaction Reply。
 *
 * 段布局（与 `buildTransactionReply` 同一套 FS 分段口径）：
 *
 * | 下标 | 内容 |
 * |---|---|
 * | 0 | 消息类 `3` |
 * | 1 | LUNO |
 * | 2 | 空 |
 * | 3 | 子类 `2` + 显示标志(1) + active keys(≤10) |
 * | 4 | 屏幕计时器，**恰好 3 位数字** |
 * | 5 | 屏幕文本（**以分号分行**） |
 * | 6 | 智能卡数据，可选，以 `CAM` 开头 |
 *
 * 显示标志：`0` 不显示、`1` 明文、`2` 隐藏输入。
 *
 * 出处：Atleos Activate 的 `BusSrv/BusSrvNDC/Source/RHProxyNDC/InteractiveResponse.cs`
 * （`ExtractSector4Fields`..`ExtractSector7Fields`；C# 里 `GetSector(msg, N, FS)` 是 1 基的，
 * 所以 sector 4 = 这里的下标 3）。
 */
function buildInteractiveResponse({
  luno,
  displayFlag = '1',
  activeKeys,
  screenTimer = 30,
  screenData,
  cam = null,
} = {}) {
  if (!activeKeys) throw new Error('buildInteractiveResponse: activeKeys is required');
  if (activeKeys.length > 10) {
    throw new Error(`buildInteractiveResponse: activeKeys "${activeKeys}" exceeds the 10-character maximum`);
  }
  if (!screenData) throw new Error('buildInteractiveResponse: screenData is required');
  // ATM 侧对这一段有严格的长度校验（不是 3 位就按段长错拒绝整条报文），补零而不是
  // 让调用方记得自己补——模拟器发一条会被拒的报文，排查成本远大于这一行。
  const timer = String(screenTimer).padStart(3, '0');
  if (timer.length !== 3) {
    throw new Error(`buildInteractiveResponse: screenTimer ${screenTimer} does not fit in 3 digits`);
  }

  const fields = ['3', luno, '', `2${displayFlag}${activeKeys}`, timer, screenData];
  if (cam != null) fields.push(cam);
  return fields.join(FS);
}

module.exports = { buildInteractiveResponse };
