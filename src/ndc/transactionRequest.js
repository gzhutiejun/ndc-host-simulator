const { GS } = require('../constants');

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
    // 带 camTail 键：GS 之后的原文（8b：`CAM<GS><tlv>[<GS><scripts>]`）；没有 GS 则不带这个键。
    const gs = seg.indexOf(GS);
    const lts = { tsn: m[1], status: parseInt(m[2], 10), dispensed, raw: seg };
    if (gs >= 0) lts.camTail = seg.slice(gs + 1);
    return lts;
  }
  return undefined;
}

/** 把 hex 串按 BER-TLV 拆开；坏数据（截断、奇数位）时停在已解出的部分。 */
function parseTlvHex(hex) {
  const out = [];
  let i = 0;
  const byte = (at) => parseInt(hex.slice(at, at + 2), 16);
  while (i + 2 <= hex.length) {
    const tagStart = i;
    const first = byte(i);
    i += 2;
    if ((first & 0x1f) === 0x1f) {
      while (i + 2 <= hex.length) {
        const b = byte(i);
        i += 2;
        if ((b & 0x80) === 0) break;
      }
    }
    const tag = hex.slice(tagStart, i).toUpperCase();
    if (i + 2 > hex.length) break;
    let len = byte(i);
    i += 2;
    if (len & 0x80) {
      const n = len & 0x7f;
      len = parseInt(hex.slice(i, i + n * 2) || '0', 16);
      i += n * 2;
    }
    if (i + len * 2 > hex.length) break;
    out.push({ tag, len, value: hex.slice(i, i + len * 2).toUpperCase() });
    i += len * 2;
  }
  return out;
}

/** 请求里的 CAM 段 `5CAM<flags 4 hex><tlv…>`；没有则 undefined。 */
function extractCam(fields) {
  for (let i = BUFFER_C_INDEX + 1; i < fields.length; i += 1) {
    const seg = fields[i] || '';
    if (!seg.startsWith('5CAM')) continue;
    return { flags: seg.slice(4, 8), tlv: parseTlvHex(seg.slice(8)) };
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
    cam: extractCam(fields),
  };
}

module.exports = { extractRequest, extractLts, extractCam, parseTlvHex };
