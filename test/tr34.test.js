const test = require('node:test');
const assert = require('node:assert');
const {
  base94Encode, base94Decode, SAMPLES, buildTr34Command, extractTr34Reply,
} = require('../src/ndc/tr34');
const { FS } = require('../src/constants');

test('base94 vectors', () => {
  assert.strictEqual(base94Encode(Buffer.from([0, 0, 0, 0])), '     ');
  assert.strictEqual(base94Encode(Buffer.from([1, 0, 0, 0])), '!    ');
  assert.strictEqual(base94Encode(Buffer.from([0xff, 0xff, 0xff, 0xff])), 'I{!!W');
  assert.strictEqual(base94Encode(Buffer.from('30820002ABCD', 'hex')), 'X6IH +z%  ');
  assert.strictEqual(base94Decode('X6IH +z%  ').toString('hex').toUpperCase(), '30820002ABCD0000');
  assert.strictEqual(base94Decode('abcd'), undefined);
});

test('samples are well-formed distinct DER', () => {
  const hexes = new Set();
  for (const b of Object.values(SAMPLES)) {
    assert.ok(b.length >= 64);
    assert.strictEqual(b[0], 0x30);
    assert.strictEqual(b[1], 0x82);
    assert.strictEqual(b[2] * 256 + b[3] + 4, b.length);
    hexes.add(b.toString('hex'));
  }
  assert.strictEqual(hexes.size, 4);
});

test('buildTr34Command shapes', () => {
  const x = buildTr34Command({ modifier: 'X' }).split(FS);
  assert.deepStrictEqual(x.slice(0, 4), ['3', '000', '', '4X']);
  assert.strictEqual(x.length, 5);
  assert.strictEqual(parseInt(x[4].slice(0, 3), 16), x[4].length - 3);
  assert.ok(base94Decode(x[4].slice(3)).subarray(0, SAMPLES.hostCert.length).equals(SAMPLES.hostCert));
  assert.strictEqual(buildTr34Command({ modifier: 'N' }).split(FS).length, 4);
  assert.strictEqual(buildTr34Command({ modifier: 'k' }).split(FS)[4], '001b');
  assert.strictEqual(buildTr34Command({ modifier: 'M' }).split(FS)[4], '0010');
  assert.strictEqual(buildTr34Command({ modifier: 'Y', data: 'zz', luno: '123' }).split(FS)[4], '002zz');
  assert.throws(() => buildTr34Command({ modifier: '?' }));
});

test('extractTr34Reply hides bodies', () => {
  const r = extractTr34Reply(['23', '000', '', '8', 'SECRETCERTBODY']);
  assert.strictEqual(r.len, 14);
  assert.match(r.text, /^TR34 .* len=14 sha256=[0-9a-f]{8}$/);
  assert.ok(!JSON.stringify(r).includes('SECRETCERTBODY'));
  assert.strictEqual(extractTr34Reply(['23', '000', '', '3', 'ABCDEF']), undefined);
  assert.strictEqual(extractTr34Reply(['23', '000', '', '4', 'x']), undefined);
});
