const test = require('node:test');
const assert = require('node:assert');
const { buildTerminalCommand } = require('../src/push');
const { FS } = require('../src/constants');

// 手册 Table 10-1：
//   "1"[响应标志] FS [LUNO] FS [消息序号] FS <命令码><命令修饰符?>
test('最小形态：只有命令码', () => {
  assert.strictEqual(buildTerminalCommand({ code: '1' }), '1' + FS + FS + FS + '1');
});

test('命令码与修饰符连写在同一字段，中间没有 FS', () => {
  assert.strictEqual(buildTerminalCommand({ code: '7', modifier: '3' }), '1' + FS + FS + FS + '73');
});

test('LUNO 与消息序号落在各自字段', () => {
  assert.strictEqual(
    buildTerminalCommand({ code: '4', luno: '000', msn: '123' }),
    '1' + FS + '000' + FS + '123' + FS + '4',
  );
});

test('响应标志紧跟消息类，不额外加 FS', () => {
  assert.strictEqual(buildTerminalCommand({ code: '1', responseFlag: 'X' }), '1X' + FS + FS + FS + '1');
});

test('缺 code 时抛错，而不是发一条没有命令码的报文', () => {
  assert.throws(() => buildTerminalCommand({}), /code/);
});
