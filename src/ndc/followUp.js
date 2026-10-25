/** 段下标：5 Track 2、6 Track 3、7 opcode、8 金额、9 PIN A、11 Buffer C。 */
const OPCODE_INDEX = 7;
const PROFILE_SEGMENTS = {
  generic: [5, 6, 7, 8, 9],
  oar: [5, 6, 7, 8, 9, 11],
};

/**
 * 主机选择（genericSelection / oarSelection 交易应答模式）的跟进报文补字段。
 *
 * ATM 照 AE 的 `CRF` 把跟进里的 Track 2 / 3、opcode、金额、PIN A（OAR 另加 Buffer C）清空，
 * 只留 Buffer B 的键。真主机靠会话记得这一笔；这里在首条请求时存底，跟进到了再把这些段
 * 拷回去，后面的 withdrawal / opcode-library 规则就能按原 opcode / 金额作答。
 */
function rememberOriginal(session, fields) {
  session.hostSelectionOriginal = fields.slice();
}

function clearOriginal(session) {
  delete session.hostSelectionOriginal;
}

/**
 * 有存底，且段 7（opcode）为空或请求已被 `mergeConfirmation` 补过（带 `confirmationKey`）。
 *
 * server.js 在 handler 之前先跑 `mergeConfirmation`（CUBC 回送用，不改）：opcode 空且 Buffer B
 * 非空时它已经把上一条请求的全部段拷了回来，只换 MCN 与 Buffer B，所以 Buffer B 非空的跟进到
 * 这里 opcode 并不为空，要靠 `confirmationKey` 认。副作用：跟进里新的 LTS（`2` 段）/ CAM 段也被
 * 原请求的那份盖掉了——这只影响模拟器看到（日志里）的内容，不影响它的应答。
 */
function isStrippedFollowUp(parsed, session) {
  if (!session || !session.hostSelectionOriginal) return false;
  const fields = (parsed && parsed.fields) || [];
  return (fields[OPCODE_INDEX] || '') === '' || parsed.confirmationKey !== undefined;
}

/** 把存底的段（`generic`：5–9；`oar`：5–9 与 11）写回 `parsed.fields`，并清存底。 */
function rehydrate(parsed, session, profile) {
  const original = session.hostSelectionOriginal || [];
  const segments = PROFILE_SEGMENTS[profile];
  if (!segments) throw new Error(`followUp.rehydrate: unknown profile "${profile}"`);
  if (!parsed.fields) parsed.fields = [];
  for (const i of segments) {
    while (parsed.fields.length <= i) parsed.fields.push('');
    parsed.fields[i] = original[i] != null ? original[i] : '';
  }
  clearOriginal(session);
  return parsed;
}

module.exports = { rememberOriginal, isStrippedFollowUp, rehydrate, clearOriginal };
