const test = require('node:test');
const assert = require('node:assert');
const { createSession } = require('../src/session');

test('nextTvn increments from 1', () => {
  const s = createSession();
  assert.strictEqual(s.nextTvn(), 1);
  assert.strictEqual(s.nextTvn(), 2);
  assert.strictEqual(s.tvn, 2);
});

test('remember captures luno from parsed message', () => {
  const s = createSession();
  s.remember({ luno: '123' });
  assert.strictEqual(s.luno, '123');
  s.remember({ luno: '' }); // 空不覆盖
  assert.strictEqual(s.luno, '123');
});
