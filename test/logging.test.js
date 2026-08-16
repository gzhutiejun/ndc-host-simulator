const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { hexDump, createLogger } = require('../src/logging');

test('hexDump formats offset, hex and ascii', () => {
  const out = hexDump(Buffer.from('AB' + String.fromCharCode(0x1c), 'latin1'));
  assert.match(out, /^00000000\s+41 42 1c/);
  assert.match(out, /\|AB\.\|/); // 0x1c 不可打印 → '.'
});

// hexdump 右栏的用途是"这一帧在说什么"。EBCDIC 下不换码的话那一栏会全是点
// （EBCDIC 的可打印字符几乎都落在 0x80 以上），排障时反而更看不清。
test('hexDump 的字符栏在 EBCDIC 传输码下按表 F-1 还原', () => {
  const { setTransmissionCode } = require('../src/ebcdic');
  setTransmissionCode('EBCDIC');
  try {
    const out = hexDump(Buffer.from([0xc1, 0xc2, 0x1c])); // EBCDIC 的 "AB" + FS
    assert.match(out, /^00000000\s+c1 c2 1c/); // hex 栏仍是线缆上的真实字节
    assert.match(out, /\|AB\.\|/);             // 字符栏还原成 ASCII
  } finally {
    setTransmissionCode('ASCII');
  }
});

test('record writes hex capture to a file', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ndc-cap-'));
  const logger = createLogger({ dir, now: () => new Date('2026-07-05T00:00:00Z') });
  logger.record('RECV', Buffer.from('22', 'latin1'), { type: 'SolicitedStatus', rule: 'gis' });
  const content = fs.readFileSync(logger.file, 'utf8');
  assert.match(content, /RECV/);
  assert.match(content, /SolicitedStatus/);
  assert.match(content, /32 32/); // "22" 的 hex
});
