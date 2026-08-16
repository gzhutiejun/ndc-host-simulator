const test = require('node:test');
const assert = require('node:assert');
const {
  decodeByte,
  encodeChar,
  getTransmissionCode,
  parseTransmissionCode,
  setTransmissionCode,
} = require('../src/ebcdic');

/**
 * B66180《APTRA Advance NDC, Reference Manual》附录 F 表 F-1 的**逐行誊抄**，
 * 格式为 `"<ASCII hex> <EBCDIC hex> <字符/控制码名>"`。
 *
 * 这张表在测试里独立于实现再写一遍是有意的冗余：src/ebcdic.js 里的表为了紧凑写成了
 * 八行十六进制串，人眼没法直接对着手册核；这里按手册的行序、带字符名逐条排开，
 * 谁都能拿 PDF 比。改实现里的表而不同步改这里，测试就会红。
 *
 * 手册 PDF 的文字层有 OCR 噪声，这里按显然的原意订正过：`\`(ASCII 5C) 的 EBCDIC 列
 * 被识别成字母 `EO`，实为 `E0`。
 */
const MANUAL_TABLE_F1 = [
  '00 00 NUL', '01 01 SOH', '02 02 STX', '03 03 ETX',
  '04 37 EOT', '05 2D ENQ', '06 2E ACK', '07 2F BEL',
  '08 08 BS', '09 05 HT', '0A 25 LF', '0B 0B VT',
  '0C 0C FF', '0D 0D CR', '0E 0E SO', '0F 0F SI',
  '10 10 DLE', '11 11 DC1', '12 12 DC2', '13 13 DC3',
  '14 3C DC4', '15 3D NAK', '16 32 SYN', '17 26 ETB',
  '18 18 CAN', '19 19 EM', '1A 3F SUB', '1B 27 ESC',
  '1C 1C FS', '1D 1D GS', '1E 1E RS', '1F 1F US',
  '20 40 SP', '21 4F !', '22 7F "', '23 7B #',
  '24 5B $', '25 6C %', '26 50 &', "27 7D '",
  '28 4D (', '29 5D )', '2A 5C *', '2B 4E +',
  '2C 6B ,', '2D 60 -', '2E 4B .', '2F 61 /',
  '30 F0 0', '31 F1 1', '32 F2 2', '33 F3 3',
  '34 F4 4', '35 F5 5', '36 F6 6', '37 F7 7',
  '38 F8 8', '39 F9 9', '3A 7A :', '3B 5E ;',
  '3C 4C <', '3D 7E =', '3E 6E >', '3F 6F ?',
  '40 7C @', '41 C1 A', '42 C2 B', '43 C3 C',
  '44 C4 D', '45 C5 E', '46 C6 F', '47 C7 G',
  '48 C8 H', '49 C9 I', '4A D1 J', '4B D2 K',
  '4C D3 L', '4D D4 M', '4E D5 N', '4F D6 O',
  '50 D7 P', '51 D8 Q', '52 D9 R', '53 E2 S',
  '54 E3 T', '55 E4 U', '56 E5 V', '57 E6 W',
  '58 E7 X', '59 E8 Y', '5A E9 Z', '5B 4A [',
  '5C E0 \\', '5D 5A ]', '5E 5F ^', '5F 6D _',
  '60 79 `', '61 81 a', '62 82 b', '63 83 c',
  '64 84 d', '65 85 e', '66 86 f', '67 87 g',
  '68 88 h', '69 89 i', '6A 91 j', '6B 92 k',
  '6C 93 l', '6D 94 m', '6E 95 n', '6F 96 o',
  '70 97 p', '71 98 q', '72 99 r', '73 A2 s',
  '74 A3 t', '75 A4 u', '76 A5 v', '77 A6 w',
  '78 A7 x', '79 A8 y', '7A A9 z', '7B C0 {',
  '7C 6A |', '7D D0 }', '7E A1 ~', '7F 07 DEL',
];

function parseRow(row) {
  const [a, e] = row.split(' ');
  return { ascii: parseInt(a, 16), ebcdic: parseInt(e, 16) };
}

test.afterEach(() => setTransmissionCode('ASCII'));

test('表 F-1 覆盖 ASCII 0x00-0x7F 全部 128 个码位，无缺口', () => {
  assert.strictEqual(MANUAL_TABLE_F1.length, 128);
  const asciiCodes = MANUAL_TABLE_F1.map((r) => parseRow(r).ascii);
  assert.deepStrictEqual(asciiCodes, [...Array(128).keys()]);
});

// 双射是反向表能无歧义存在的前提：两个 ASCII 字符映到同一个 EBCDIC 码的话，
// ATM 发来的那个码该还原成哪一个就没有答案了。
test('表 F-1 是双射 —— 128 个码位映到 128 个互不相同的 EBCDIC 码', () => {
  const ebcdicCodes = MANUAL_TABLE_F1.map((r) => parseRow(r).ebcdic);
  assert.strictEqual(new Set(ebcdicCodes).size, 128);
});

test('EBCDIC 模式下逐条按表 F-1 编码', () => {
  setTransmissionCode('EBCDIC');
  for (const row of MANUAL_TABLE_F1) {
    const { ascii, ebcdic } = parseRow(row);
    assert.strictEqual(encodeChar(ascii), ebcdic, `encode ${row}`);
  }
});

test('EBCDIC 模式下逐条按表 F-1 解码', () => {
  setTransmissionCode('EBCDIC');
  for (const row of MANUAL_TABLE_F1) {
    const { ascii, ebcdic } = parseRow(row);
    assert.strictEqual(decodeByte(ebcdic), ascii, `decode ${row}`);
  }
});

test('EBCDIC 模式下编解码往返对 0x00-0x7F 恒等', () => {
  setTransmissionCode('EBCDIC');
  for (let c = 0; c < 0x80; c += 1) {
    assert.strictEqual(decodeByte(encodeChar(c)), c);
  }
});

// 这四个是 NDC 帧结构本身依赖的字符。表 F-1 把它们映到自己，所以 parser.js 里
// 按字符比较 FS/ETX、以及 framing.js 的长度前缀逻辑在 EBCDIC 下依然成立。
test('FS/GS/RS/ETX 在两种编码下同码', () => {
  setTransmissionCode('EBCDIC');
  for (const c of [0x1c, 0x1d, 0x1e, 0x03]) {
    assert.strictEqual(encodeChar(c), c);
    assert.strictEqual(decodeByte(c), c);
  }
});

test('表外字节原样透传（不替换成占位符）', () => {
  setTransmissionCode('EBCDIC');
  assert.strictEqual(encodeChar(0x80), 0x80);
  assert.strictEqual(encodeChar(0xff), 0xff);
  // 0x41 在表 F-1 的 EBCDIC 列里没有出现（EBCDIC 未分配位）
  assert.strictEqual(decodeByte(0x41), 0x41);
});

test('缺省是 ASCII，且编解码都是恒等变换', () => {
  assert.strictEqual(getTransmissionCode(), 'ASCII');
  for (let b = 0; b < 0x100; b += 1) {
    assert.strictEqual(encodeChar(b), b);
    assert.strictEqual(decodeByte(b), b);
  }
});

test('parseTransmissionCode 认得 ASCII/EBCDIC，大小写不敏感', () => {
  assert.strictEqual(parseTransmissionCode('EBCDIC'), 'EBCDIC');
  assert.strictEqual(parseTransmissionCode('ebcdic'), 'EBCDIC');
  assert.strictEqual(parseTransmissionCode('ASCII'), 'ASCII');
});

test('parseTransmissionCode 没配时回落到 ASCII', () => {
  assert.strictEqual(parseTransmissionCode(undefined), 'ASCII');
  assert.strictEqual(parseTransmissionCode(null), 'ASCII');
  assert.strictEqual(parseTransmissionCode(''), 'ASCII');
});

// 配错值不能悄悄当成 EBCDIC（那会让每帧都变乱码，现象离原因很远），也不该让
// 模拟器起不来：回落到 ASCII 并在 stderr 上说明白。
test('parseTransmissionCode 配了不认识的值时回落到 ASCII', () => {
  assert.strictEqual(parseTransmissionCode('EBCDIK'), 'ASCII');
  assert.strictEqual(parseTransmissionCode(42), 'ASCII');
});
