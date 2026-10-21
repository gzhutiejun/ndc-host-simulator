/** Buffer C 的段下标；Last Transaction Status 段出现在它之后（Track 1 占位之后）。 */
const BUFFER_C_INDEX = 11;
// "2" + TSN(4) + 状态(1) + 4 × 5 位出钞张数（NDC 钞箱类型 1..4）。有 BNA / option 45 / 76 时后面还有
// 更多位，这里只取前 26 字符，完整内容留在 raw。
const LTS_PATTERN = /^2(\d{4})(\d)(\d{20})/;

function extractLts(fields) {
  for (let i = BUFFER_C_INDEX + 1; i < fields.length; i += 1) {
    const seg = fields[i] || '';
    if (seg[0] !== '2') continue;
    const m = LTS_PATTERN.exec(seg);
    if (!m) continue;
    const dispensed = [];
    for (let k = 0; k < 4; k += 1) dispensed.push(parseInt(m[3].slice(k * 5, k * 5 + 5), 10));
    return { tsn: m[1], status: parseInt(m[2], 10), dispensed, raw: seg };
  }
  return undefined;
}

function extractRequest(parsed, config = {}) {
  const amountFieldIndex = config.amountFieldIndex != null ? config.amountFieldIndex : 8;
  const fields = parsed.fields || [];
  const amountRaw = fields[amountFieldIndex];
  const amount = amountRaw && /^\d+$/.test(amountRaw) ? parseInt(amountRaw, 10) : null;
  const field4 = fields[4] || '';
  const mcn = field4.length > 1 ? field4[1] : '';
  return {
    amount,
    luno: parsed.luno,
    stn: fields[2] || '',
    mcn,
    panMasked: fields[5] || '',
    lts: extractLts(fields),
  };
}

module.exports = { extractRequest, extractLts };
