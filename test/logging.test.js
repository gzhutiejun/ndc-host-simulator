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

test('record writes hex capture to a file', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ndc-cap-'));
  const logger = createLogger({ dir, now: () => new Date('2026-07-05T00:00:00Z') });
  logger.record('RECV', Buffer.from('22', 'latin1'), { type: 'SolicitedStatus', rule: 'gis' });
  const content = fs.readFileSync(logger.file, 'utf8');
  assert.match(content, /RECV/);
  assert.match(content, /SolicitedStatus/);
  assert.match(content, /32 32/); // "22" 的 hex
});
