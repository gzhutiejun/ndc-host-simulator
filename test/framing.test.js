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
