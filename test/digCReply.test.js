const test = require('node:test');
const assert = require('node:assert');
const makeDigCReply = require('../src/handlers/digCReply');
const { parse } = require('../src/ndc/parser');
const { encodeText } = require('../src/framing');
const { FS, GS } = require('../src/constants');

const status = (f3, f4) => parse(encodeText(['22', '000', '', f3, f4, '2', 'CAM9F0607A0000000031010'].join(FS)));
const ON = { enabled: true, nextState: '048', receipt: 'CARD DECLINED' };

test('digCReply: DIG c 回 class 4，MCN 0 / FID 5 / NS，凭条，不带 CAM', () => {
  const f = makeDigCReply(ON)(status('8', 'c1'), { nextTvn: () => 7 }).split(FS);
  assert.strictEqual(f[0], '4');
  assert.strictEqual(f[1], '000');
  assert.strictEqual(f[3], '048');
  assert.strictEqual(f[5], '0007' + '5' + '000');
  assert.strictEqual(f[6], '0' + '0' + '3' + 'CARD DECLINED');
  assert.strictEqual(f.length, 7);
  assert.ok(!f.join(FS).includes('5CAM'));
});

test('digCReply: nextState / receipt 取自配置', () => {
  const f = makeDigCReply({ enabled: true, nextState: '123', receipt: 'X<LF>Y' })(status('8', 'c2'), {}).split(FS);
  assert.strictEqual(f[3], '123');
  assert.ok(f[6].endsWith('X\nY'));
});

test('digCReply: enabled:false -> null；DIG D 与 Ready 不匹配', () => {
  assert.strictEqual(makeDigCReply({ ...ON, enabled: false })(status('8', 'c1'), {}), null);
  assert.strictEqual(makeDigCReply({})(status('8', 'c1'), {}), null);
  assert.strictEqual(makeDigCReply(ON)(status('8', 'D1'), {}), null);
  assert.strictEqual(makeDigCReply(ON)(status('9', 'c1'), {}), null);
  assert.strictEqual(makeDigCReply(ON)(parse(encodeText(['12', '000', '', '8', 'c1'].join(FS))), {}), null);
});
