const test = require('node:test');
const assert = require('node:assert');
const goInService = require('../src/handlers/goInService');
const { applyTemplate } = require('../src/engine');
const constants = require('../src/constants');
const { FS } = constants;
const { parse } = require('../src/ndc/parser');
const { encodeText } = require('../src/framing');
const { createSession } = require('../src/session');

test('goInService returns "1<FS><FS><FS>1" terminal command', () => {
  const p = parse(encodeText('22' + FS + '123' + FS + FS + 'B0000'));
  const session = createSession();
  const out = goInService(p, session, { applyTemplate, ctx: { luno: '123', tvn: '0' }, constants });
  assert.strictEqual(out, '1' + FS + FS + FS + '1');
});
