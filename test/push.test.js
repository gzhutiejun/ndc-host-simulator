const test = require('node:test');
const assert = require('node:assert');
const { buildTerminalCommand, buildDataCommand, buildFitDownload } = require('../src/push');
const { FS } = require('../src/constants');

// 报文库 StandardInterface_0300_English_Messages.doc 里 key = "FIT" 的那条真实样本，
// 逐字节抄下来当基准。下面的"金标准"用例就是拿它钉住 buildFitDownload 的输出。
const FIT_ENTRY_SAMPLE =
  '023000255255255255255002000132000015000031138255007001035069103137001035069' +
  '000000000000000000000000064064064000000000';
const FIT_SAMPLE_PAYLOAD = '30' + FS + '218' + FS + '000' + FS + '15' + FS + FIT_ENTRY_SAMPLE + FS;

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

// ---- 类 3 数据命令 ----
//   "3"[响应标志] FS [LUNO] FS [消息序号] FS <报文标识> FS <数据>

test('数据命令的最小形态：只有报文标识和数据', () => {
  assert.strictEqual(
    buildDataCommand({ identifier: '16', data: '0001' }),
    '3' + FS + FS + FS + '16' + FS + '0001',
  );
});

test('数据命令的响应标志紧跟消息类，LUNO/消息序号各占一段', () => {
  assert.strictEqual(
    buildDataCommand({ identifier: '15', data: 'X', responseFlag: '0', luno: '218', msn: '000' }),
    '30' + FS + '218' + FS + '000' + FS + '15' + FS + 'X',
  );
});

test('数据命令缺 identifier 时抛错', () => {
  assert.throws(() => buildDataCommand({ data: 'X' }), /identifier/);
});

// ---- FIT 下发（报文标识 15）----

test('金标准：与报文库里 key 为 FIT 的真实样本逐字节相等', () => {
  assert.strictEqual(
    buildFitDownload({ responseFlag: '0', luno: '218', msn: '000', entries: [FIT_ENTRY_SAMPLE] }),
    FIT_SAMPLE_PAYLOAD,
  );
});

test('每条 FIT 条目后面跟一个 FS，多条时连续排列', () => {
  assert.strictEqual(
    buildFitDownload({ entries: ['000', '255'] }),
    '3' + FS + FS + FS + '15' + FS + '000' + FS + '255' + FS,
  );
});

test('条目为空数组时抛错，而不是发一条没有 FIT 数据的下发命令', () => {
  assert.throws(() => buildFitDownload({ entries: [] }), /entries/);
});

test('条目里混进非数字时抛错（每字节写成 3 位十进制，只允许 0-9）', () => {
  assert.throws(() => buildFitDownload({ entries: ['02300A'] }), /digits/);
});

test('条目长度不是 3 的倍数时抛错（凑不齐整字节）', () => {
  assert.throws(() => buildFitDownload({ entries: ['0230'] }), /multiple of 3/);
});
