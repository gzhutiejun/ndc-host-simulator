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
 * DDC 应答里的 EMV 段——`ddcReplySectors()`（acc-cubc 的 `ddc-reply-sectors.ts`）
 * 靠含 `'9'` 的段判定"打印数据到这里为止"，这段就是那个边界。
 *
 * 现网真实样本形状：`'9''M'0016B64CEDA6008000000000123230373730`——`'9'` 是边界
 * 标记，`'M'` 紧随其后，再往后是一串十六进制数据。**内层字段级含义没有核实**：
 * acc-cubc 自己解出这一段之后也只当不透明串存着，从没有下游代码真正读它
 * （`ndc-codec.ts` 把它填进 `reply.cam`，全仓找不到第二处引用）。所以这里只保证
 * **外层形状**——两个引号标记 + 由 `arc` 编出的十六进制——跟标准 NDC 的 `buildCam`
 * （`receipt.js`）是同一条纪律：让分段逻辑测得到、不是字节级还原真实密文。
 *
 * @param arc 授权响应码，同 `buildCam` 的用法。
 * @param include 假不返回 `null`（同 `buildCam`，调用方据此决定要不要把这段接进
 *        `buildDdcTransactionReply` 的 `cam` 参数）。
 */
function buildDdcEmvSegment(arc, include) {
  return include ? `'9''M'${arcToHex(arc)}` : null;
}

module.exports = { buildDdcTransactionReply, buildDdcEmvSegment };
