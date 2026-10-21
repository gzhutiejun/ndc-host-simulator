const test = require('node:test');
const assert = require('node:assert');
const makeReplyFee = require('../src/handlers/replyFee');
const { parse } = require('../src/ndc/parser');
const { encodeText } = require('../src/framing');
const { FS } = require('../src/constants');

// 位 7 = opcode 的下标 6（opcode 在段 7）。MCN 取段 4 的第 2 个字符。
function req(opcode, mcn = '7') {
  const fields = ['11', '000', '', '', '1' + mcn, ';X=X?', '', opcode, '00010000', '', ''];
  return parse(encodeText(fields.join(FS)));
}
const ON = { enabled: true };

test('replyFee: 缺省关闭，恒返回 null', () => {
  assert.strictEqual(makeReplyFee({})(req('A A  A A')), null);
  assert.strictEqual(makeReplyFee({ enabled: false })(req('A A  A A')), null);
});

test('replyFee: 位 7 为空格 -> class 4 应答，NS 008、屏 Fee=$2.00、FID 5、回显 MCN', () => {
  const f = makeReplyFee(ON)(req('A A  A A')).split(FS);
  assert.strictEqual(f[0], '4');
  assert.strictEqual(f[1], '000');
  assert.strictEqual(f[3], '008');
  assert.strictEqual(f[5][4], '5'); // 屏幕段 = TSN(4) + FID(1)：FID 5，不动介质
  assert.ok(f[5].split(';').includes('Fee=$2.00'), 'Fee 单独成行，ATM 的 parseFeeAmount 按行取');
  assert.strictEqual(f[6][0], '7'); // 回显 MCN
});

test('replyFee: 屏幕 FID 为 5（非介质），nextState / fee 可配', () => {
  const f = makeReplyFee({ enabled: true, nextState: '010', fee: '$3.50' })(req('A A  A A')).split(FS);
  assert.strictEqual(f[3], '010');
  assert.ok(f[5].split(';').includes('Fee=$3.50'));
});

test('replyFee: 位 7 为 A / C -> null（接受重发交给后面的规则）', () => {
  const h = makeReplyFee(ON);
  assert.strictEqual(h(req('A A  AAA')), null);
  assert.strictEqual(h(req('A A  ACA')), null);
});

test('replyFee: 位 7 为 B / D -> 取消应答 NS 048、凭条 TRANSACTION CANCELLED / FEE DECLINED、回显 MCN', () => {
  const h = makeReplyFee(ON);
  for (const flag of ['B', 'D']) {
    const f = h(req('A A  A' + flag + 'A', '4')).split(FS);
    assert.strictEqual(f[0], '4');
    assert.strictEqual(f[3], '048');
    assert.strictEqual(f[6][0], '4');
    assert.strictEqual(f[6][1], '0');
    assert.strictEqual(f[6][2], '3'); // 打印标志 3：凭条 + 日志
    assert.strictEqual(f[5][4], '5'); // FID 5：ATM 对取消应答拒绝介质 FID
    assert.ok(f[6].includes('TRANSACTION CANCELLED'));
    assert.ok(f[6].includes('FEE DECLINED'));
  }
});

test('replyFee: cancelReplyNextState 可配；noReplyToCancel 时取消请求不应答', () => {
  const f = makeReplyFee({ enabled: true, cancelReplyNextState: '049' })(req('A A  ABA')).split(FS);
  assert.strictEqual(f[3], '049');
  assert.deepStrictEqual(makeReplyFee({ enabled: true, noReplyToCancel: true })(req('A A  ABA')), { noReply: true });
});
