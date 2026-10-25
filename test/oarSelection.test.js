const test = require('node:test');
const assert = require('node:assert');
const makeOar = require('../src/handlers/oarSelection');
const { parse } = require('../src/ndc/parser');
const { encodeText } = require('../src/framing');
const { FS } = require('../src/constants');

function req(opcode, bufferB = '', mcn = '3') {
  const fields = ['11', '000', '', '', '1' + mcn, ';X=X?', '', opcode, '00010000', '', bufferB, ''];
  return parse(encodeText(fields.join(FS)));
}
const ACCOUNTS = [
  { number: '1234567890', name: 'SAVINGS' },
  { number: '2234567890', name: 'CHEQUE' },
];
const ON = { enabled: true, accounts: ACCOUNTS };
const WITHDRAW = 'A A  A A';
const TRANSFER = 'D  A B  ';
const PIN_CHANGE = 'ID    A ';

test('oarSelection: 缺省关闭，恒返回 null', () => {
  assert.strictEqual(makeOar({ accounts: ACCOUNTS })(req(WITHDRAW), {}), null);
});

test('oarSelection: 首条请求回 ITR，屏 FROM;AccountANumber=…，两个账户 active keys 0110000000', () => {
  const f = makeOar(ON)(req(WITHDRAW), {}).split(FS);
  assert.strictEqual(f[0], '3');
  assert.strictEqual(f[1], '000');
  assert.strictEqual(f[3], '21' + '0110000000');
  assert.strictEqual(f[4].length, 3);
  assert.strictEqual(
    f[5],
    'FROM;AccountANumber=1234567890;AccountAName=SAVINGS;AccountBNumber=2234567890;AccountBName=CHEQUE;',
  );
});

test('oarSelection: 三个账户 -> 开 A B C', () => {
  const accounts = [...ACCOUNTS, { number: '3', name: 'X' }];
  const f = makeOar({ enabled: true, accounts })(req(WITHDRAW), {}).split(FS);
  assert.strictEqual(f[3], '21' + '0111000000');
});

test('oarSelection: Buffer B 为按位字母表前 n 个 -> null 放行', () => {
  const h = makeOar(ON);
  assert.strictEqual(h(req(WITHDRAW, 'A'), {}), null);
  assert.strictEqual(h(req(WITHDRAW, 'B'), {}), null);
});

test('oarSelection: 字母表 A B C D I H G F 按位对应（第 5 个账户是 I，active keys 开 FDK I）', () => {
  const accounts = ['1', '2', '3', '4', '5'].map((n) => ({ number: n + '00000', name: 'N' + n }));
  const h = makeOar({ enabled: true, accounts });
  assert.strictEqual(h(req(WITHDRAW, 'I'), {}), null);
  assert.strictEqual(h(req(WITHDRAW, 'F'), {}), null); // 字母表内的字母一律放行，不会因为越界重问成死循环
  const f = h(req(WITHDRAW), {}).split(FS);
  assert.strictEqual(f[3], '21' + '0111100001'); // 数字键关；A B C D 与 I 开
  assert.ok(f[5].includes('AccountENumber=500000;AccountEName=N5;'), '第 5 个账户的键名仍按 A.. 顺序编号，按键回 I');
});

test('oarSelection: E -> 取消应答 FID 5、NS 048、凭条 TRANSACTION CANCELLED，回显 MCN', () => {
  const f = makeOar(ON)(req(WITHDRAW, 'E', '6'), {}).split(FS);
  assert.strictEqual(f[0], '4');
  assert.strictEqual(f[3], '048');
  assert.strictEqual(f[6][0], '6');
  assert.strictEqual(f[5][4], '5'); // FID 5
  assert.ok(f[6].includes('TRANSACTION CANCELLED'));
  assert.strictEqual(f[6][2], '3');
  assert.ok(!f[6].includes('\x1d'));
});

test('oarSelection: direction auto 下转账 opcode 用 TO;，direction to 恒 TO;', () => {
  assert.ok(makeOar({ ...ON, direction: 'auto' })(req(TRANSFER), {}).split(FS)[5].startsWith('TO;'));
  assert.ok(makeOar({ ...ON, direction: 'auto' })(req(WITHDRAW), {}).split(FS)[5].startsWith('FROM;'));
  assert.ok(makeOar({ ...ON, direction: 'to' })(req(WITHDRAW), {}).split(FS)[5].startsWith('TO;'));
});

test('oarSelection: 存款 opcode 缺省不触发，includeDeposit 才触发', () => {
  assert.strictEqual(makeOar(ON)(req('BB  A A '), {}), null);
  assert.ok(makeOar({ ...ON, includeDeposit: true })(req('BB  A A '), {}));
});

test('oarSelection: 改密 opcode 缺省不触发，includePinChange 才触发', () => {
  assert.strictEqual(makeOar(ON)(req(PIN_CHANGE), {}), null);
  assert.ok(makeOar({ ...ON, includePinChange: true })(req(PIN_CHANGE), {}));
});

// ---- path: "reply"（交易应答 NS 071 / 073）----
/** ATM 的 OAR 跟进：段 5–9 与 11 清空，Buffer B = 账户键。 */
function stripped(bufferB, mcn = '4') {
  const fields = ['11', '000', '', '', '1' + mcn, '', '', '', '', '', bufferB, ''];
  return parse(encodeText(fields.join(FS)));
}
function reqWithC(opcode, mcn = '3') {
  const fields = ['11', '000', '', '', '1' + mcn, ';X=X?', '', opcode, '00010000', '', '', 'BUFC'];
  return parse(encodeText(fields.join(FS)));
}
const REPLY = { ...ON, path: 'reply' };

test('oarSelection reply: 首条取款 -> 类 4，NS 071，FID 5 屏 Account<n> 键', () => {
  const f = makeOar(REPLY)(req(WITHDRAW, '', '6'), {}).split(FS);
  assert.strictEqual(f[0], '4');
  assert.strictEqual(f[3], '071');
  assert.strictEqual(f[5][4], '5');
  assert.ok(f[5].includes(';Account1Number=1234567890;Account1Name=SAVINGS;Account2Number=2234567890;Account2Name=CHEQUE;'));
  assert.strictEqual(f[6], '60');
});

test('oarSelection reply: direction to -> 073；auto 下转账 073、取款 071；NS 可配', () => {
  assert.strictEqual(makeOar({ ...REPLY, direction: 'to' })(req(WITHDRAW), {}).split(FS)[3], '073');
  assert.strictEqual(makeOar({ ...REPLY, direction: 'auto' })(req(TRANSFER), {}).split(FS)[3], '073');
  assert.strictEqual(makeOar({ ...REPLY, direction: 'auto' })(req(WITHDRAW), {}).split(FS)[3], '071');
  assert.strictEqual(makeOar({ ...REPLY, fromNextState: '072' })(req(WITHDRAW), {}).split(FS)[3], '072');
});

test('oarSelection reply: 账户上限 10', () => {
  const accounts = Array.from({ length: 12 }, (_, i) => ({ number: String(i + 1), name: 'N' + (i + 1) }));
  const screen = makeOar({ ...REPLY, accounts })(req(WITHDRAW), {}).split(FS)[5];
  assert.ok(screen.includes('Account10Number=10;'));
  assert.ok(!screen.includes('Account11Number'));
});

test('oarSelection reply: 跟进 B=2 -> null，段 5–9 与 11 补回', () => {
  const h = makeOar(REPLY);
  const session = {};
  h(reqWithC(WITHDRAW), session);
  const parsed = stripped('2');
  assert.strictEqual(h(parsed, session), null);
  assert.strictEqual(parsed.fields[7], WITHDRAW);
  assert.strictEqual(parsed.fields[8], '00010000');
  assert.strictEqual(parsed.fields[11], 'BUFC');
  assert.strictEqual(parsed.fields[10], '2');
});

test('oarSelection reply: 跟进 B=10 也放行', () => {
  const h = makeOar(REPLY);
  const session = {};
  h(req(WITHDRAW), session);
  assert.strictEqual(h(stripped('10'), session), null);
});

test('oarSelection reply: 跟进 E -> 取消应答 NS 048；其余键也取消，不落到批准', () => {
  const h = makeOar(REPLY);
  const s1 = {};
  h(req(WITHDRAW), s1);
  const f = h(stripped('E', '5'), s1).split(FS);
  assert.strictEqual(f[0], '4');
  assert.strictEqual(f[3], '048');
  assert.ok(f[6].includes('TRANSACTION CANCELLED'));
  assert.strictEqual(s1.hostSelectionOriginal, undefined);
  for (const key of ['', 'A', '11']) {
    const s = {};
    h(req(WITHDRAW), s);
    assert.strictEqual(h(stripped(key), s).split(FS)[3], '048', `key ${JSON.stringify(key)}`);
  }
});

test('oarSelection reply: 存款 / 改密 include 开关同 ITR 模式', () => {
  assert.strictEqual(makeOar(REPLY)(req('BB  A A '), {}), null);
  assert.strictEqual(makeOar({ ...REPLY, includeDeposit: true })(req('BB  A A '), {}).split(FS)[3], '071');
  assert.strictEqual(makeOar(REPLY)(req(PIN_CHANGE), {}), null);
  assert.ok(makeOar({ ...REPLY, includePinChange: true })(req(PIN_CHANGE), {}));
});
