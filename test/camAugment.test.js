const test = require('node:test');
const assert = require('node:assert');
const { augmentCam } = require('../src/ndc/camAugment');
const { buildCam } = require('../src/ndc/receipt');
const { parse } = require('../src/ndc/parser');
const { encodeText } = require('../src/framing');
const { FS } = require('../src/constants');

const withCam = (extra = []) => parse(encodeText(
  ['11', '000', '', '', '17', ';X=X?', '', 'A A  A A', '00010000', '', '', '', '5CAM00049F2701809F3602000A', ...extra].join(FS),
));
const noCam = () => parse(encodeText(['11', '000', '', '', '17', ';X=X?', '', 'A A  A A', '00010000', '', '', ''].join(FS)));
const reply = ['4', '000', '', '001', '', '0001500', '0010'].join(FS);
const ON = { enabled: true, arc: '00', iad: '11223344556677883030', scripts: [] };

test('buildCam 对象签名：缺省 = 91 + xfssim 接受的 IAD + ARC 00', () => {
  assert.strictEqual(buildCam({}), '5CAM910A11223344556677883030' + '8A023030');
});

test('buildCam: omit91 + arc 05；脚本连写；旧签名不变', () => {
  assert.strictEqual(buildCam({ omit91: true, arc: '05' }), '5CAM8A023035');
  assert.strictEqual(buildCam({ omit91: true, scripts: ['7201', '7202'] }), '5CAM8A0230307201' + '7202');
  assert.strictEqual(buildCam('00', true), '5CAM8A023030');
  assert.strictEqual(buildCam('00', false), null);
});

test('augmentCam: 末尾补 FS + CAM', () => {
  const r = augmentCam(withCam(), { payload: reply, rule: 'x' }, ON);
  assert.strictEqual(r.payload, reply + FS + buildCam({}));
  assert.strictEqual(r.rule, 'x');
});

test('augmentCam: arc / scripts 取自配置', () => {
  const r = augmentCam(withCam(), { payload: reply, rule: 'x' }, { ...ON, arc: '05', scripts: ['7201'] });
  assert.ok(r.payload.endsWith(FS + buildCam({ arc: '05', scripts: ['7201'] })));
});

test('augmentCam: badIad 把 IAD 首字节改成 FF', () => {
  const r = augmentCam(withCam(), { payload: reply, rule: 'x' }, { ...ON, badIad: true });
  assert.ok(r.payload.endsWith(FS + '5CAM910AFF223344556677883030' + '8A023030'));
});

test('augmentCam: 请求无 5CAM / omit / 已有 5 段 / 非 class 4 / 未启用，都原样', () => {
  const same = (parsed, payload, cfg) => {
    const input = { payload, rule: 'x' };
    assert.strictEqual(augmentCam(parsed, input, cfg), input);
  };
  same(noCam(), reply, ON);
  same(withCam(), reply, { ...ON, omit: true });
  same(withCam(), reply + FS + '5CAM8A023030', ON);
  same(withCam(), ['3', '000', '', '21'].join(FS), ON);
  same(withCam(), reply, { ...ON, enabled: false });
  same(withCam(), reply, undefined);
  same(withCam(), null, ON);
});
