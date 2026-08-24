const test = require('node:test');
const assert = require('node:assert');
const makeDdcPinValidation = require('../src/handlers/ddcPinValidation');
const { parse } = require('../src/ndc/parser');
const { encodeText } = require('../src/framing');
const { FS } = require('../src/constants');
const { createSession } = require('../src/session');

// 形状取自现网真实报文（终端 008823，2024-01-15 MSG.EJ）：
// 11<FS>CUB<FS><FS><FS>15<FS>;461760...=...?<FS><FS>HHH A   <FS>000000000000<FS>...
function hhhReq() {
  return parse(encodeText([
    '11', 'CUB', '', '', '15', ';461760XXXXXX7710=XXXXXXXXXXXXXXXXXXXX?', '',
    'HHH A   ', '000000000000',
  ].join(FS)));
}
const helpers = { applyTemplate: (s) => s, ctx: {}, constants: require('../src/constants'), now: () => new Date() };

test('approves PIN validation: class 4, next-state 803, no dispense', () => {
  const handler = makeDdcPinValidation({});
  const out = handler(hhhReq(), createSession(), helpers);
  const f = out.split(FS);
  assert.strictEqual(f[0], '4');
  assert.strictEqual(f[1], 'CUB'); // LUNO echoed
  assert.strictEqual(f[3], '803');
  assert.strictEqual(f[4], ''); // fieldG — PIN 验证不动钱，不出钞
});

test('next-state is configurable', () => {
  const handler = makeDdcPinValidation({ nextState: '833' });
  const out = handler(hhhReq(), createSession(), helpers);
  assert.strictEqual(out.split(FS)[3], '833');
});

test('screen/printer templates are applied', () => {
  const handler = makeDdcPinValidation({ screen: 'SCR', printer: 'RCPT' });
  const out = handler(hhhReq(), createSession(), helpers);
  const f = out.split(FS);
  assert.strictEqual(f[5], 'SCR');
  assert.strictEqual(f[6], 'RCPT');
});

// 现网样本（终端 008823，2024-01-15 07:44:56）的 HHH 应答就是 10 段形状，多出一段
// EMV 边界标记——见 buildDdcEmvSegment。出厂默认关闭（同标准 NDC 的 includeCam）。
test('includeCam appends the EMV boundary segment (off by default)', () => {
  const off = makeDdcPinValidation({})(hhhReq(), createSession(), helpers);
  assert.strictEqual(off.split(FS).length, 7);

  const on = makeDdcPinValidation({ includeCam: true, camArc: '00' })(hhhReq(), createSession(), helpers);
  const f = on.split(FS);
  assert.strictEqual(f.length, 8);
  assert.strictEqual(f[7], "'9''M'3030");
});
