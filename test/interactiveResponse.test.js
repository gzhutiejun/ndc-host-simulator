const test = require('node:test');
const assert = require('node:assert');
const { buildInteractiveResponse } = require('../src/ndc/interactiveResponse');

test('active keys 位图原样放进段 3', () => {
  const msg = buildInteractiveResponse({ luno: '000', activeKeys: '0110000000', screenData: 'X' });
  assert.strictEqual(msg.split('\x1c')[3], '210110000000');
});

test('active keys 写成按键字母会被拦下', () => {
  assert.throws(
    () => buildInteractiveResponse({ luno: '000', activeKeys: 'AB', screenData: 'X' }),
    /0\/1 bitmap/,
  );
});
