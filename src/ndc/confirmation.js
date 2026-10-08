const OPCODE_INDEX = 7;
const MCN_INDEX = 4;
const BUFFER_B_INDEX = 10;

/**
 * CUBC 终端对 ITR 的回送只带新 MCN 与 Buffer B，其余段全空（现网 17/17 条手续费回送，例
 * 2024-02-20 07:37:40：`11<FS>CUB<FS><FS><FS>1;<FS><FS><FS><FS><FS><FS>C<FS>`；acc-cubc
 * core/request/ddc-confirmation.ts）。真实主机靠会话记得它回的是哪一笔；这里把它合并到本会话
 * 上一条交易请求上（换掉 MCN 与 Buffer B），下游 handler 照常按操作码 + Buffer B 判断。
 *
 * 操作码非空的请求原样返回，并记成「上一条」：整条重发的回送（标准 NDC 形状）也照旧能用。
 */
function mergeConfirmation(parsed, session) {
  if (!parsed || parsed.type !== 'TransactionRequest') return parsed;
  const fields = parsed.fields || [];
  if ((fields[OPCODE_INDEX] || '') !== '') {
    session.lastTransactionRequest = parsed;
    return parsed;
  }
  const last = session.lastTransactionRequest;
  const key = fields[BUFFER_B_INDEX] || '';
  if (!last || key === '') return parsed;
  const merged = [...last.fields];
  merged[MCN_INDEX] = fields[MCN_INDEX] || merged[MCN_INDEX];
  merged[BUFFER_B_INDEX] = key;
  return { ...parsed, fields: merged, confirmationKey: key };
}

module.exports = { mergeConfirmation };
