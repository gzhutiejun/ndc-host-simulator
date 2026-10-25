const test = require('node:test');
const assert = require('node:assert');
const makeGeneric = require('../src/handlers/genericSelection');
const { parse } = require('../src/ndc/parser');
const { encodeText } = require('../src/framing');
const { FS } = require('../src/constants');

function req(opcode, bufferB = '', mcn = '3') {
  const fields = ['11', '000', '', '', '1' + mcn, ';X=X?', '', opcode, '00010000', '', bufferB, ''];
  return parse(encodeText(fields.join(FS)));
}
/** ATM 的通用选择跟进：段 5–9 清空，Buffer B = 键。 */
function followUp(bufferB, mcn = '3') {
  const fields = ['11', '000', '', '', '1' + mcn, '', '', '', '', '', bufferB, ''];
  return parse(encodeText(fields.join(FS)));
}
const WITHDRAW = 'A A  A A';
const ON = { enabled: true };

test('genericSelection: 缺省关闭，恒返回 null', () => {
  assert.strictEqual(makeGeneric({})(req(WITHDRAW), {}), null);
});

test('genericSelection: ITR 首条 -> ITR，active keys 按按钮字母开位，屏 CONDITIONAL / MSG / BUTTON', () => {
  const f = makeGeneric(ON)(req(WITHDRAW), {}).split(FS);
  assert.strictEqual(f[0], '3');
  assert.strictEqual(f[3], '21' + '0110000000');
  assert.strictEqual(f[4], '030');
  assert.strictEqual(f[5], 'CONDITIONAL=LITERAL;MSG=Opt in?;BUTTONATEXT=Yes;BUTTONBTEXT=No;');
});

test('genericSelection: 按钮 F 开第 7 位；message 空时不写 MSG', () => {
  const f = makeGeneric({ ...ON, message: '', buttons: [{ letter: 'F', code: 'X' }] })(req(WITHDRAW), {}).split(FS);
  assert.strictEqual(f[3], '21' + '0000001000');
  assert.strictEqual(f[5], 'CONDITIONAL=LITERAL;BUTTONFCODE=X;');
});

test('genericSelection: path reply 首条 -> 类 4，NS 071，FID 5 屏含 CONDITIONAL', () => {
  const f = makeGeneric({ ...ON, path: 'reply' })(req(WITHDRAW, '', '6'), {}).split(FS);
  assert.strictEqual(f[0], '4');
  assert.strictEqual(f[3], '071');
  assert.strictEqual(f[5][4], '5');
  assert.ok(f[5].includes(';CONDITIONAL=LITERAL;'));
  assert.ok(f[5].endsWith(';BUTTONBTEXT=No;'));
  assert.strictEqual(f[6], '60');
});

test('genericSelection: 跟进 B=A -> null，段 5–9 补回原值', () => {
  const h = makeGeneric(ON);
  const session = {};
  h(req(WITHDRAW), session);
  const parsed = followUp('A', '4');
  assert.strictEqual(h(parsed, session), null);
  assert.strictEqual(parsed.fields[7], 'A A  A A');
  assert.strictEqual(parsed.fields[8], '00010000');
  assert.strictEqual(parsed.fields[5], ';X=X?');
  assert.strictEqual(session.hostSelectionOriginal, undefined);
});

test('genericSelection: 跟进 B=E -> 取消应答 NS 048', () => {
  const h = makeGeneric(ON);
  const session = {};
  h(req(WITHDRAW), session);
  const f = h(followUp('E', '5'), session).split(FS);
  assert.strictEqual(f[0], '4');
  assert.strictEqual(f[3], '048');
  assert.strictEqual(f[6][0], '5');
  assert.ok(f[6].includes('TRANSACTION CANCELLED'));
  assert.strictEqual(session.hostSelectionOriginal, undefined);
});

test('genericSelection: 跟进 B 空串也放行', () => {
  const h = makeGeneric(ON);
  const session = {};
  h(req(WITHDRAW), session);
  const parsed = followUp('');
  assert.strictEqual(h(parsed, session), null);
  assert.strictEqual(parsed.fields[7], WITHDRAW);
});

test('genericSelection: code 为空串也写 BUTTON<x>CODE=;', () => {
  const f = makeGeneric({ ...ON, buttons: [{ letter: 'A', code: '' }] })(req(WITHDRAW), {}).split(FS);
  assert.ok(f[5].includes('BUTTONACODE=;'));
  assert.ok(!f[5].includes('BUTTONATEXT'));
});

test('genericSelection: 存款 / 改密缺省不触发，include 开关才触发', () => {
  assert.strictEqual(makeGeneric(ON)(req('BB  A A '), {}), null);
  assert.ok(makeGeneric({ ...ON, includeDeposit: true })(req('BB  A A '), {}));
  assert.strictEqual(makeGeneric(ON)(req('ID    A '), {}), null);
  assert.ok(makeGeneric({ ...ON, includePinChange: true })(req('ID    A '), {}));
});
