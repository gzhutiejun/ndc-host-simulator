/**
 * NDC 的**传输码**（transmission code）：ASCII 或 EBCDIC。
 *
 * 一部分 NDC 主机在线缆上用 EBCDIC 而不是 ASCII，模拟器要能扮演这种主机。码表照抄
 * B66180《APTRA Advance NDC, Reference Manual》附录 F "ASCII/EBCDIC Conversion Table"
 * 表 F-1，与 ATM 侧（acc-ndc-app 的 core/ndc-charset.js）是同一张表。
 *
 * ## 换码只发生在 socket 边界
 *
 * 只有 `framing.js` 的 `encodeWire`/`decodeWire` 会调本模块。**`encodeText`/`decodeText`
 * 保持纯 latin1 不动**——它们还被 `message-library.js` 用来读磁盘上的 NCR 报文库，
 * 那是文件编码，不是线缆编码，跟着换会把整个报文库读成乱码。
 *
 * 引擎、规则匹配、报文库、handler 全都在 ASCII 串上工作，一行不用改。
 *
 * ## 与 CP500 的差异
 *
 * 表 F-1 的可打印区基本等同 EBCDIC CP500（International）。逐位比对只有两处不同，
 * **一律以手册为准**：`BS`（ASCII 08）手册是 `08` 而 CP500 是 `16`；`|`（ASCII 7C）
 * 手册是 `6A` 而 CP500 是 `BB`。对接的主机若坚持标准 CP500，这两位是第一个要查的地方。
 *
 * ## 收发对称
 *
 * 手册的 transmission code 是整帧、收发同一种的口径，本模块的开关也是。
 */

/**
 * 表 F-1 的 ASCII → EBCDIC 列，按 ASCII 码位 0x00-0x7F 顺序排开，每行 16 个。
 *
 * 写成紧凑的十六进制串是为了让整张表一屏看得见，代价是人眼没法直接对着手册核；
 * 核对交给 test/ebcdic.test.js —— 那里按手册行序、带字符名逐条誊抄了一遍，
 * 两份对不上测试就红。改这里必须同步改那里。
 */
const ASCII_TO_EBCDIC_HEX =
  '00010203372D2E2F0805250B0C0D0E0F' + // 00-0F  NUL..SI
  '101112133C3D322618193F271C1D1E1F' + // 10-1F  DLE..US（含 FS 1C / GS 1D / RS 1E）
  '404F7F7B5B6C507D4D5D5C4E6B604B61' + // 20-2F  SP ! " # $ % & ' ( ) * + , - . /
  'F0F1F2F3F4F5F6F7F8F97A5E4C7E6E6F' + // 30-3F  0-9 : ; < = > ?
  '7CC1C2C3C4C5C6C7C8C9D1D2D3D4D5D6' + // 40-4F  @ A-O
  'D7D8D9E2E3E4E5E6E7E8E94AE05A5F6D' + // 50-5F  P-Z [ \ ] ^ _
  '79818283848586878889919293949596' + // 60-6F  ` a-o
  '979899A2A3A4A5A6A7A8A9C06AD0A107';  // 70-7F  p-z { | } ~ DEL

/** 表 F-1 只定义了 ASCII 0x00-0x7F。 */
const MAPPED_ASCII_COUNT = 0x80;

// 两张表都先铺成恒等：表外的字节原样透传（理由见 warnUnmapped）。
const ASCII_TO_EBCDIC = new Uint8Array(256);
const EBCDIC_TO_ASCII = new Uint8Array(256);
const EBCDIC_MAPPED = new Array(256).fill(false);
for (let b = 0; b < 256; b += 1) {
  ASCII_TO_EBCDIC[b] = b;
  EBCDIC_TO_ASCII[b] = b;
}
for (let ascii = 0; ascii < MAPPED_ASCII_COUNT; ascii += 1) {
  const ebcdic = parseInt(ASCII_TO_EBCDIC_HEX.substr(ascii * 2, 2), 16);
  ASCII_TO_EBCDIC[ascii] = ebcdic;
  EBCDIC_TO_ASCII[ebcdic] = ascii;
  EBCDIC_MAPPED[ebcdic] = true;
}

let transmissionCode = 'ASCII';

/** 已经就哪些字节警告过了，按方向各一份——同一个值只吵一次，不同的值仍然各报一条。 */
const warnedEncode = new Set();
const warnedDecode = new Set();

/**
 * 表外字节**原样透传**，不替换成 '?' 之类的占位符。
 *
 * NDC 的载荷本来就是 7-bit 的；线上真出现表外字节，说明对端或某条规则的载荷已经出了
 * 问题。替换成占位符会把证据抹掉，只留下一条"某个字段是乱码"的现象；透传至少让原始
 * 字节仍然能在 hexdump 里被看到。所以这里只在 stderr 上说一声，不改数据。
 */
function warnUnmapped(seen, byte, direction) {
  if (seen.has(byte)) return;
  seen.add(byte);
  const hex = byte.toString(16).padStart(2, '0').toUpperCase();
  console.error(`[ebcdic] ${direction}: 0x${hex} 不在表 F-1 中，原样透传`);
}

/** 设置传输码。server.js 启动时按 config.json 设一次；测试里用来复位。 */
function setTransmissionCode(code) {
  transmissionCode = code;
}

function getTransmissionCode() {
  return transmissionCode;
}

/**
 * 读 config.json 的 `transmissionCode`。
 *
 * 不认识的值回落到 ASCII 并在 stderr 上说明白：配错了不能悄悄当成 EBCDIC（那会让每一帧
 * 都变乱码，而现象离原因很远），也不该让模拟器起不来。
 */
function parseTransmissionCode(value) {
  if (value === undefined || value === null || value === '') return 'ASCII';
  const normalized = typeof value === 'string' ? value.trim().toUpperCase() : '';
  if (normalized === 'EBCDIC') return 'EBCDIC';
  if (normalized === 'ASCII') return 'ASCII';
  console.error(`[ebcdic] transmissionCode=${JSON.stringify(value)} 无法识别，按 ASCII 处理`);
  return 'ASCII';
}

/** ASCII 字符码 → 线缆字节。ASCII 模式下是恒等变换。 */
function encodeChar(charCode) {
  const byte = charCode & 0xff;
  if (transmissionCode === 'ASCII') return byte;
  if (byte >= MAPPED_ASCII_COUNT) warnUnmapped(warnedEncode, byte, 'encode');
  return ASCII_TO_EBCDIC[byte];
}

/** 线缆字节 → ASCII 字符码。ASCII 模式下是恒等变换。 */
function decodeByte(byte) {
  const b = byte & 0xff;
  if (transmissionCode === 'ASCII') return b;
  if (!EBCDIC_MAPPED[b]) warnUnmapped(warnedDecode, b, 'decode');
  return EBCDIC_TO_ASCII[b];
}

module.exports = {
  setTransmissionCode,
  getTransmissionCode,
  parseTransmissionCode,
  encodeChar,
  decodeByte,
};
