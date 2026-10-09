const test = require('node:test');
const assert = require('node:assert');
const makeDdcCssFeeStage = require('../src/handlers/ddcCssFeeStage');
const { parse } = require('../src/ndc/parser');
const { encodeText } = require('../src/framing');
const { FS, GS } = require('../src/constants');
const { createSession } = require('../src/session');

function req(opcode, amount = '000000005000') {
  return parse(encodeText([
    '11', 'CUB', '', '', '17', ';637079XXXXXX0001=XXXXXXXXXXXXXXXXXXXX?', '',
    opcode, amount, ':;<=>?12', '', '',
  ].join(FS)));
}

test('他行 CSS 卡取款手续费段 AAFF → 551，普通交易应答，Z000933 手续费（Diebold trace）', () => {
  const f = makeDdcCssFeeStage({ nextState: '551' })(req('AAFFAAC '), createSession()).split(FS);
  assert.strictEqual(f[0], '4');
  assert.strictEqual(f[3], '551');
  const parts = f[5].split(GS);
  assert.match(parts[0], /^\d{4};$/);
  assert.deepStrictEqual(parts.slice(1), ['Z0009330.45 USD', 'Z000962', '5025']);
});

test('位 6 = B → 手续费币种 KHR', () => {
  const f = makeDdcCssFeeStage({ nextState: '071', fee: '500.00' })(req('BAFCABC ', '000000000000'), createSession()).split(FS);
  assert.strictEqual(f[3], '071');
  assert.ok(f[5].includes('Z000933500.00 KHR'));
});
