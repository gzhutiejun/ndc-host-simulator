const { GS } = require('../constants');

// 供应计数应答（22 FS luno FS FS F FS <info>）里 info 的解码。
//   基本格式：info 首字符 '2'，其后定长 111（共 112）：TSN 4、累计 7、四个钞箱类型 ×（箱内 拒钞 已付 上笔，各 5）、
//             吞卡 5、信封 5、相机 5、末笔信封 5。
//   扩展格式：info 首字符 '7'，其后按 GS 分组，组 ID 为各组首字符，顺序 A B C I J K：
//             A tsn4 + 累计7；B 吞卡5；C 每槽 28（类型3 箱内5 拒5 付5 上笔5 已存入5）；
//             I 每单元 类型3 箱内5 钞种数3 {钞种hex4 张数5}×钞种数；J 每仓 6（仓号hex1 张数5）；K 退5 拒5 入5 暂5。
//             最后一组后面不应有 GS（trailingGs 记录是否有）。

const BASIC_LENGTH = 112;
const num = (s) => parseInt(s, 10);

function parseBasic(info) {
  if (info.length !== BASIC_LENGTH) {
    return { kind: 'basic', error: `basic supply counters must be ${BASIC_LENGTH} chars, got ${info.length}` };
  }
  if (!/^\d+$/.test(info.slice(1))) {
    return { kind: 'basic', error: 'basic supply counters contain non-digit characters' };
  }
  // 字段为主序（见应用 ndc-supply-counters.ts）：四个类型的箱内、再四个拒钞、再四个已付、再四个上笔。
  const field = (base) => [0, 1, 2, 3].map((i) => num(info.slice(base + 5 * i, base + 5 * i + 5)));
  const notes = field(12);
  const rejected = field(32);
  const dispensed = field(52);
  const last = field(72);
  const cassettes = notes.map((n, i) => ({ notes: n, rejected: rejected[i], dispensed: dispensed[i], last: last[i] }));
  return {
    kind: 'basic',
    tsn: info.slice(1, 5),
    accumulated: num(info.slice(5, 12)),
    cassettes,
    cardsCaptured: num(info.slice(92, 97)),
    envelopes: num(info.slice(97, 102)),
    camera: num(info.slice(102, 107)),
    lastEnvelope: num(info.slice(107, 112)),
  };
}

function parseI(body, errors, num) {
  const cassettes = [];
  let p = 0;
  while (p < body.length) {
    if (body.length - p < 11) { errors.push(`I: truncated unit header at ${p}`); break; }
    const type = num(body.slice(p, p + 3));
    const notes = num(body.slice(p + 3, p + 8));
    const n = num(body.slice(p + 8, p + 11));
    p += 11;
    if (Number.isNaN(n) || body.length - p < n * 9) { errors.push(`I: truncated note types for unit ${type}`); break; }
    const noteTypes = [];
    for (let i = 0; i < n; i += 1) {
      noteTypes.push({ id: parseInt(body.slice(p, p + 4), 16), count: num(body.slice(p + 4, p + 9)) });
      p += 9;
    }
    cassettes.push({ type, notes, noteTypes });
  }
  return { cassettes };
}

function parseExtended(info) {
  const trailingGs = info.endsWith(GS);
  const chunks = (trailingGs ? info.slice(0, -1) : info).split(GS);
  chunks[0] = chunks[0].slice(1); // 去掉报文标识 '7'
  const groups = {};
  const unknownGroups = [];
  const errors = [];
  const num = (str) => {
    if (!/^\d+$/.test(str)) {
      errors.push(`non-digit numeric field "${str}"`);
      return 0;
    }
    return parseInt(str, 10);
  };
  for (const chunk of chunks) {
    if (chunk === '') continue;
    const id = chunk[0];
    const body = chunk.slice(1);
    switch (id) {
      case 'A':
        if (body.length !== 11) { errors.push(`A: body must be 11 chars, got ${body.length}`); break; }
        groups.A = { tsn: body.slice(0, 4), accumulated: num(body.slice(4, 11)) };
        break;
      case 'B':
        if (body.length !== 5) { errors.push(`B: body must be 5 chars, got ${body.length}`); break; }
        groups.B = { captured: num(body) };
        break;
      case 'C': {
        if (body.length % 28 !== 0) { errors.push(`C: body length ${body.length} is not a multiple of 28`); break; }
        const types = [];
        for (let o = 0; o < body.length; o += 28) {
          types.push({
            type: num(body.slice(o, o + 3)),
            notes: num(body.slice(o + 3, o + 8)),
            rejected: num(body.slice(o + 8, o + 13)),
            dispensed: num(body.slice(o + 13, o + 18)),
            last: num(body.slice(o + 18, o + 23)),
            deposited: num(body.slice(o + 23, o + 28)),
          });
        }
        groups.C = { types };
        break;
      }
      case 'I':
        groups.I = parseI(body, errors, num);
        break;
      case 'J': {
        if (body.length % 6 !== 0) { errors.push(`J: body length ${body.length} is not a multiple of 6`); break; }
        const bins = [];
        for (let o = 0; o < body.length; o += 6) {
          bins.push({ bin: parseInt(body[o], 16), count: num(body.slice(o + 1, o + 6)) });
        }
        groups.J = { bins };
        break;
      }
      case 'K':
        if (body.length !== 20) { errors.push(`K: body must be 20 chars, got ${body.length}`); break; }
        groups.K = {
          refunded: num(body.slice(0, 5)),
          rejected: num(body.slice(5, 10)),
          encashed: num(body.slice(10, 15)),
          escrowed: num(body.slice(15, 20)),
        };
        break;
      default:
        unknownGroups.push(id);
    }
  }
  return { kind: 'extended', groups, unknownGroups, trailingGs, errors };
}

/** info 是 22…F 报文里第 4 个字段（首字符 2 = 基本，7 = 扩展）。其它首字符返回 undefined。 */
function parseSupplyCountersStatus(info) {
  if (typeof info !== 'string') return undefined;
  if (info[0] === '2') return parseBasic(info);
  if (info[0] === '7') return parseExtended(info);
  return undefined;
}

module.exports = { parseSupplyCountersStatus };
