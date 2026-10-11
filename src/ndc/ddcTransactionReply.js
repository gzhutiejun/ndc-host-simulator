const { FS } = require('../constants');
const { arcToHex } = require('./receipt');

/**
 * DDC（CUBC 方言）交易应答的最简形态。
 *
 * 字段形状与标准 NDC 的 `transactionReply.js` 完全一样：
 * `[4, luno, stn, nextState, fieldG, screen, printer, cam?]`。
 *
 * 真实 DDC 应答的打印数据**可以从字段 6 起跨多个 FS 段**，直到遇上一段含 `'9'`
 * 标记（EMV）的段为止——见 acc-cubc 的 `ddc-reply-sectors.ts`（`ddcReplySectors`）。
 * 单个 printer 段、没有 EMV 段是这条规则下的合法简单情形（`parts=[fields[6]]`，
 * 没有后续段可并），所以这里先复用与标准 NDC 相同的单段形状；等接多段/EMV 场景
 * （取款/余额两段式）时再扩展 `printer` 支持多段输入，不用现在就做。
 *
 * 单独建一个文件而不是直接用 `transactionReply.js`：字段形状目前相同，但 DDC 与
 * 标准 NDC 的语义来源不同（DDC 没有 CAM 概念，`cam` 参数这里其实是"EMV 段"，
 * 字面上恰好长得一样），后续两边会独立演化（DDC 加多段 printer、标准 NDC 不会），
 * 现在分开能让改动不互相牵连。
 */
function buildDdcTransactionReply({
  luno,
  stn = '',
  nextState,
  fieldG,
  screen = '',
  printer = '',
  cam = null,
} = {}) {
  const fields = ['4', luno, stn, nextState, fieldG, screen, printer];
  if (cam != null) fields.push(cam);
  return fields.join(FS);
}

/**
 * DDC 应答里的 EMV 段，照现网形状（acc-cubc `docs/cubc/host-messages.md` §3.6，旧终端
 * `NDCMessageModifier.ConvertSector8ReplyFields`）：`'9''M'` + 授权响应码 2 位 + 发卡行认证数据
 * （2 位十进制长度 + 数据 → tag 91）+ 发卡行脚本（3 位长度 + 数据）+ 授权码（2 位长度 + 数据）。
 * 现网例：`'9''M'0016B64CEDA60080000000012323037373730`。
 *
 * 91 用 `1122334455667788` + ARC 的十六进制（10 字节）：acc-xfs-simulator 的芯片测试卡
 * （`config/cubc-chip-cards.yaml`）只认 `EXTERNAL AUTHENTICATE 008200000A11223344556677883030`，
 * 批准（ARC 00）时发卡行认证能在 VM 上走通；拒绝时不匹配，卡片照样给 AAC。不下发脚本，授权码长度 00。
 *
 * @param arc 授权响应码，2 位数字（`00` 批准、`05` / `51` 拒绝…）。
 * @param include 假不返回 `null`（调用方据此决定要不要把这段接进 `buildDdcTransactionReply` 的 `cam`）。
 */
function buildDdcEmvSegment(arc, include) {
  if (!include) return null;
  const a = String(arc).padStart(2, '0').slice(0, 2);
  const iad = '1122334455667788' + arcToHex(a);
  return `'9''M'${a}${String(iad.length).padStart(2, '0')}${iad}00000`;
}

module.exports = { buildDdcTransactionReply, buildDdcEmvSegment };
