const test = require('node:test');
const assert = require('node:assert');
const { encodeLength, createDecoder } = require('../src/framing');

test('encodeLength prefixes 2-byte big-endian length', () => {
  const out = encodeLength(Buffer.from('AB', 'latin1'));
  assert.deepStrictEqual([...out], [0x00, 0x02, 0x41, 0x42]);
});

test('decoder returns a single complete frame', () => {
  const d = createDecoder();
  const frame = encodeLength(Buffer.from('hello', 'latin1'));
  const frames = d.push(frame);
  assert.strictEqual(frames.length, 1);
  assert.strictEqual(frames[0].toString('latin1'), 'hello');
});

test('decoder splits two frames arriving in one chunk (粘包)', () => {
  const d = createDecoder();
  const chunk = Buffer.concat([
    encodeLength(Buffer.from('AA', 'latin1')),
    encodeLength(Buffer.from('BBB', 'latin1')),
  ]);
  const frames = d.push(chunk);
  assert.deepStrictEqual(frames.map((f) => f.toString('latin1')), ['AA', 'BBB']);
});

test('decoder reassembles a frame split across chunks (半包)', () => {
  const d = createDecoder();
  const full = encodeLength(Buffer.from('WORLD', 'latin1'));
  assert.deepStrictEqual(d.push(full.subarray(0, 3)), []); // 长度头都没凑齐
  const frames = d.push(full.subarray(3));
  assert.strictEqual(frames.length, 1);
  assert.strictEqual(frames[0].toString('latin1'), 'WORLD');
});

test('decoder handles length header split across chunks', () => {
  const d = createDecoder();
  const full = encodeLength(Buffer.from('XY', 'latin1')); // [00 02 58 59]
  assert.deepStrictEqual(d.push(full.subarray(0, 1)), []); // 只有 1 个长度字节
  const frames = d.push(full.subarray(1));
  assert.strictEqual(frames[0].toString('latin1'), 'XY');
});

const { encodeText, decodeText } = require('../src/framing');

test('encodeText/decodeText round-trip all bytes 0x00-0xFF (字节保真)', () => {
  const bytes = Buffer.from(Array.from({ length: 256 }, (_, i) => i));
  const str = decodeText(bytes);
  const back = encodeText(str);
  assert.deepStrictEqual([...back], [...bytes]);
});

test('decodeText preserves control chars', () => {
  const buf = Buffer.from([0x32, 0x32, 0x1c, 0x39]); // "22" FS "9"
  assert.strictEqual(decodeText(buf), '22\x1c9');
});

// ---- 线缆编解码（encodeWire/decodeWire）与传输码 ----

const { encodeWire, decodeWire } = require('../src/framing');
const { setTransmissionCode } = require('../src/ebcdic');

test.afterEach(() => setTransmissionCode('ASCII'));

test('ASCII 传输码下 encodeWire/decodeWire 与 encodeText/decodeText 逐字节一致', () => {
  const text = '4\x1c000\x1c\x1c074';
  assert.deepStrictEqual([...encodeWire(text)], [...encodeText(text)]);
  const buf = Buffer.from([0x34, 0x1c, 0x30, 0x30, 0x30]);
  assert.strictEqual(decodeWire(buf), decodeText(buf));
});

test('EBCDIC 传输码下 encodeWire 按表 F-1 换码', () => {
  setTransmissionCode('EBCDIC');
  assert.deepStrictEqual([...encodeWire('A1')], [0xc1, 0xf1]);
});

test('EBCDIC 下 FS 在线缆上仍然是 0x1c —— 分段字符两码同值', () => {
  setTransmissionCode('EBCDIC');
  assert.deepStrictEqual([...encodeWire('11\x1c000')], [0xf1, 0xf1, 0x1c, 0xf0, 0xf0, 0xf0]);
});

test('EBCDIC 下 decodeWire 把线缆字节还原成 ASCII 串', () => {
  setTransmissionCode('EBCDIC');
  const buf = Buffer.from([0xf4, 0x1c, 0xf0, 0xf0, 0xf0, 0xc1]);
  assert.strictEqual(decodeWire(buf), '4\x1c000A');
});

test('EBCDIC 下 encodeWire/decodeWire 往返恒等（全部可打印 ASCII + 控制字符）', () => {
  setTransmissionCode('EBCDIC');
  let text = '';
  for (let c = 0x20; c < 0x7f; c += 1) text += String.fromCharCode(c);
  text = ['4', '000', text, '074'].join('\x1c');
  assert.strictEqual(decodeWire(encodeWire(text)), text);
});

// 报文库是磁盘上的 latin1 文件，不是线缆。encodeText/decodeText 必须对传输码免疫，
// 否则 EBCDIC 配置下整个 NCR 报文库会被读成乱码。
test('EBCDIC 传输码不影响 encodeText/decodeText（报文库读盘用的是它们）', () => {
  setTransmissionCode('EBCDIC');
  assert.deepStrictEqual([...encodeText('A1')], [0x41, 0x31]);
  assert.strictEqual(decodeText(Buffer.from([0x41, 0x31])), 'A1');
});
