const test = require('node:test');
const assert = require('node:assert');
const { applyReceipt, fmtAmount, fmtDate, fmtTime, arcToHex, buildCam } = require('../src/ndc/receipt');
const { SO, SI, GS } = require('../src/constants');

test('applyReceipt substitutes value placeholders and control chars', () => {
  const out = applyReceipt('A=<AMOUNT> B=<BALANCE><LF><ESC>x<SO><SI><GS>', {
    amount: '300.00', balance: '5000.00',
  });
  assert.strictEqual(out, 'A=300.00 B=5000.00\n\x1bx' + SO + SI + GS);
});

test('applyReceipt replaces missing placeholders with empty string', () => {
  assert.strictEqual(applyReceipt('[<PAN>][<RECNO>]', {}), '[][]');
});

test('applyReceipt does NOT treat <FS> as a token (left literal)', () => {
  assert.strictEqual(applyReceipt('a<FS>b', {}), 'a<FS>b');
});

test('fmtAmount / fmtDate / fmtTime use 2 decimals and UTC', () => {
  assert.strictEqual(fmtAmount(300), '300.00');
  const d = new Date('2026-06-02T09:52:00Z');
  assert.strictEqual(fmtDate(d), '02/06/26');
  assert.strictEqual(fmtTime(d), '09:52');
});

test('arcToHex and buildCam', () => {
  assert.strictEqual(arcToHex('00'), '3030');
  assert.strictEqual(buildCam('00', true), '5CAM8A023030');
  assert.strictEqual(buildCam('00', false), null);
});

test('buildCam 对象签名：默认 IAD、omit91、脚本', () => {
  assert.strictEqual(buildCam({}), '5CAM910A11223344556677883030' + '8A023030');
  assert.strictEqual(buildCam({ omit91: true, arc: '05' }), '5CAM8A023035');
  assert.strictEqual(buildCam({ omit91: true, scripts: ['72', '73'] }), '5CAM8A02303072' + '73');
});
