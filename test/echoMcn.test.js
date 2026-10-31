const test = require('node:test');
const assert = require('node:assert');
const { echoMcn } = require('../src/ndc/echoMcn');

const FS = '\x1c';
const req = (field4) => ({ fields: ['11', 'CUB', '', '', field4, ';4617=?', '', 'BA BA C '] });

test('交易应答的打印字段通配 0 换成请求的 MCN', () => {
  const reply = ['4', 'CUB', '', '063', '', '0011;', '002 RECEIPT'].join(FS);
  assert.strictEqual(echoMcn(req('1<'), reply).split(FS)[6], '<02 RECEIPT');
});

test('打印字段为空、已带具体 MCN、不是交易应答、请求没 MCN 时不动', () => {
  const empty = ['4', 'CUB', '', '547', '', '', ''].join(FS);
  assert.strictEqual(echoMcn(req('1<'), empty), empty);
  const already = ['4', 'CUB', '', '063', '', '', '702'].join(FS);
  assert.strictEqual(echoMcn(req('1<'), already), already);
  const itr = ['3', 'CUB', '', '210110010000', '037', 'X'].join(FS);
  assert.strictEqual(echoMcn(req('1<'), itr), itr);
  const reply = ['4', 'CUB', '', '063', '', '', '002'].join(FS);
  assert.strictEqual(echoMcn(req('1'), reply), reply);
  assert.strictEqual(echoMcn({ fields: ['22', 'CUB', '', 'B'] }, reply), reply);
  assert.strictEqual(echoMcn(req('1<'), null), null);
});
