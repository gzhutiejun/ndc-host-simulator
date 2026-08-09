const test = require('node:test');
const assert = require('node:assert');
const { parseLibrary, describe: describeMessage } = require('../src/message-library');
const { FS } = require('../src/constants');

const HEADER = 'M1187RESV\r\n'; // 11 字节文件头
const RECORD_SIZE = 614;
const LENGTH_FIELD_SIZE = 4;
const KEY_FIELD_SIZE = 8;

// 内联构造一条 614 字节的记录，不依赖真实文件（CI 上没有它，真实文件也不许进测试夹具）。
function buildRecord(key, payload, { padChar = ' ' } = {}) {
  if (key.length > KEY_FIELD_SIZE) throw new Error('key too long for test helper');
  const lengthField = String(payload.length).padStart(LENGTH_FIELD_SIZE, '0');
  const keyField = key.padEnd(KEY_FIELD_SIZE, ' ');
  const head = lengthField + keyField + payload;
  if (head.length > RECORD_SIZE) throw new Error('record too long for test helper');
  return head.padEnd(RECORD_SIZE, padChar);
}

function buildLibrary(records, { header = HEADER } = {}) {
  return header + records.join('');
}

test('parseLibrary: 解析单条记录，key 与 payload 都对', () => {
  const buf = Buffer.from(buildLibrary([buildRecord('GIS', '1' + FS + FS + FS + '1')]), 'latin1');
  const result = parseLibrary(buf);
  assert.strictEqual(result.length, 1);
  assert.strictEqual(result[0].key, 'GIS');
  assert.strictEqual(result[0].payload, '1' + FS + FS + FS + '1');
  assert.strictEqual(result.skipped, 0);
});

test('parseLibrary: 两条记录按 614 字节边界正确切分', () => {
  const rec1 = buildRecord('GIS', '1' + FS + FS + FS + '1');
  const rec2 = buildRecord('OOS', '1' + FS + FS + FS + '2');
  const buf = Buffer.from(buildLibrary([rec1, rec2]), 'latin1');
  const result = parseLibrary(buf);
  assert.strictEqual(result.length, 2);
  assert.strictEqual(result[0].key, 'GIS');
  assert.strictEqual(result[0].payload, '1' + FS + FS + FS + '1');
  assert.strictEqual(result[1].key, 'OOS');
  assert.strictEqual(result[1].payload, '1' + FS + FS + FS + '2');
});

test('parseLibrary: 记录尾部补位空格被丢弃，载荷内部的空格原样保留', () => {
  // 载荷本身含有意义的空格（比如屏幕文案），必须跟"补位到 614 字节"的空格区分开。
  const payload = 'A B  C' + FS + 'hello world';
  const buf = Buffer.from(buildLibrary([buildRecord('KEY1', payload)]), 'latin1');
  const result = parseLibrary(buf);
  assert.strictEqual(result[0].payload, payload); // 内部空格没被吃掉
  assert.strictEqual(result[0].payload.endsWith(' '), false); // 尾部补位空格没有混进来
});

// 键是定长 8 字节字段，尾部空格纯粹是补位（NCR 场景名从来不会真的以空格收尾），
// trim 掉才是人能看的键；但键内部的空格（"A A  A A" 这种）是场景名本身的一部分，
// 必须原样保留，否则不同键会被 trim 撞成同一个字符串。两种情况都钉住。
test('parseLibrary: 键尾部空格被 trim，键内部空格保留（"A A  A A" 这种场景名）', () => {
  const recTrailing = buildRecord('GIS', '1' + FS + FS + FS + '1'); // "GIS     " -> "GIS"
  const recInternal = buildRecord('A A  A A', '4' + FS + '000'); // 恰好 8 字节，内部含空格
  const buf = Buffer.from(buildLibrary([recTrailing, recInternal]), 'latin1');
  const result = parseLibrary(buf);
  assert.strictEqual(result[0].key, 'GIS');
  assert.strictEqual(result[1].key, 'A A  A A');
});

test('parseLibrary: 长度字段不是数字时跳过该记录并计数，不抛错', () => {
  const bad = 'BAD!' + 'BADKEY  '.padEnd(KEY_FIELD_SIZE, ' ') + 'x'.repeat(RECORD_SIZE - LENGTH_FIELD_SIZE - KEY_FIELD_SIZE);
  assert.strictEqual(bad.length, RECORD_SIZE);
  const good = buildRecord('GIS', '1' + FS + FS + FS + '1');
  const buf = Buffer.from(buildLibrary([bad, good]), 'latin1');
  assert.doesNotThrow(() => parseLibrary(buf));
  const result = parseLibrary(buf);
  assert.strictEqual(result.length, 1);
  assert.strictEqual(result[0].key, 'GIS');
  assert.strictEqual(result.skipped, 1);
  assert.strictEqual(result.skippedDetails[0].index, 0);
});

test('parseLibrary: 声明长度超出记录容量时跳过该记录并计数，不抛错', () => {
  // 记录容量是 614 - 4 - 8 = 602 字节；声明 9999 字节的载荷不可能装得下。
  const overflowLen = '9999';
  const bad = overflowLen + 'BADKEY  '.padEnd(KEY_FIELD_SIZE, ' ') + 'x'.repeat(RECORD_SIZE - LENGTH_FIELD_SIZE - KEY_FIELD_SIZE);
  assert.strictEqual(bad.length, RECORD_SIZE);
  const good = buildRecord('OOS', '1' + FS + FS + FS + '2');
  const buf = Buffer.from(buildLibrary([bad, good]), 'latin1');
  const result = parseLibrary(buf);
  assert.strictEqual(result.length, 1);
  assert.strictEqual(result[0].key, 'OOS');
  assert.strictEqual(result.skipped, 1);
});

test('parseLibrary: 文件长度不是 11+614n（尾部多出几个字节）时不抛错，前面的整记录照常解析', () => {
  const good = buildRecord('GIS', '1' + FS + FS + FS + '1');
  const buf = Buffer.from(buildLibrary([good]) + 'xyz', 'latin1'); // 多出 3 个字节的垃圾尾巴
  const result = parseLibrary(buf);
  assert.strictEqual(result.length, 1);
  assert.strictEqual(result[0].key, 'GIS');
  assert.strictEqual(result.skipped, 1);
});

test('parseLibrary: 空文件 / 比文件头还短的文件不抛错，返回空库', () => {
  assert.doesNotThrow(() => parseLibrary(Buffer.alloc(0)));
  assert.deepStrictEqual([...parseLibrary(Buffer.alloc(0))], []);
  assert.doesNotThrow(() => parseLibrary(Buffer.from('M118', 'latin1')));
  assert.deepStrictEqual([...parseLibrary(Buffer.from('M118', 'latin1'))], []);
});

test('parseLibrary: 接受字符串输入（latin1），跟 Buffer 输入结果一致', () => {
  const good = buildRecord('GIS', '1' + FS + FS + FS + '1');
  const asString = buildLibrary([good]);
  const asBuffer = Buffer.from(asString, 'latin1');
  assert.deepStrictEqual([...parseLibrary(asString)], [...parseLibrary(asBuffer)]);
});

test('parseLibrary: 返回值本身是数组（可直接 JSON.stringify 成 [{key,payload}]，不带 skipped 元数据）', () => {
  const good = buildRecord('GIS', '1' + FS + FS + FS + '1');
  const result = parseLibrary(Buffer.from(buildLibrary([good]), 'latin1'));
  assert.ok(Array.isArray(result));
  assert.strictEqual(JSON.stringify(result), JSON.stringify([{ key: 'GIS', payload: '1' + FS + FS + FS + '1' }]));
});

// ---- describe ----

test('describe: 类 1 已知命令码映射成人话（Go In Service / Go Out Of Service）', () => {
  const gis = describeMessage('1' + FS + FS + FS + '1');
  assert.strictEqual(gis.messageClass, '1');
  assert.strictEqual(gis.subClass, '1');
  assert.match(gis.label, /Go In Service/);

  const oos = describeMessage('1' + FS + FS + FS + '2');
  assert.match(oos.label, /Go Out Of Service/);
});

test('describe: 类 1 未知命令码不编名字，标签里带上原始命令码', () => {
  const d = describeMessage('1' + FS + FS + FS + '99');
  assert.strictEqual(d.subClass, '99');
  assert.match(d.label, /99/);
  assert.match(d.label, /未知/);
});

test('describe: 类 3 已知子码（COMMSKEY，子码 32）标注"密钥变更"', () => {
  const d = describeMessage('3' + FS + FS + FS + '32' + FS + '020193062042095255162143');
  assert.strictEqual(d.messageClass, '3');
  assert.strictEqual(d.subClass, '32');
  assert.strictEqual(d.label, '密钥变更');
});

test('describe: 类 3 未知子码不编含义，只报子码', () => {
  const d = describeMessage('3' + FS + '000' + FS + FS + '21100111' + FS + '074' + FS + 'SURCHARGE FEE=$1.75');
  assert.strictEqual(d.subClass, '21100111');
  assert.doesNotMatch(d.label, /密钥/); // 不能瞎猜成密钥变更
});

test('describe: 类 4 交易应答拼出"下一状态 + 出钞面额"标签', () => {
  // 取自真实样本结构：4|000||001|01000000|...（第 4 段 next state，第 5 段出钞面额）
  const payload = ['4', '000', '', '001', '01000000', '12342000000\x0f@@', '003'].join(FS);
  const d = describeMessage(payload);
  assert.strictEqual(d.messageClass, '4');
  assert.strictEqual(d.subClass, '001');
  assert.strictEqual(d.label, '交易应答 · 下一状态 001 · 出钞 01000000');
});

test('describe: 类 4 无出钞字段时标签里不出现"出钞"部分', () => {
  const payload = ['4', '000', '', '441', ''].join(FS);
  const d = describeMessage(payload);
  assert.strictEqual(d.label, '交易应答 · 下一状态 441');
  assert.doesNotMatch(d.label, /出钞/);
});

test('describe: 类 4 段数不够、认不出下一状态时诚实说不知道，不瞎猜', () => {
  const d = describeMessage('4');
  assert.strictEqual(d.messageClass, '4');
  assert.strictEqual(d.subClass, null);
  assert.match(d.label, /无法识别/);
});

test('describe: 未识别的报文类回退到"类 N 报文"，已知类名（C2T_CLASS）时用上类名', () => {
  const known = describeMessage('8' + FS + 'whatever'); // C2T_CLASS['8'] === 'EMVConfig'
  assert.strictEqual(known.label, 'EMVConfig 报文');

  const unknown = describeMessage('9' + FS + 'whatever');
  assert.strictEqual(unknown.label, '类 9 报文');
});

test('describe: 空载荷不抛错，标签说明是空报文', () => {
  const d = describeMessage('');
  assert.strictEqual(d.label, '空报文');
  assert.deepStrictEqual(d.fields, []);
});

test('describe: fields 是按 FS 切分的原始段，空字段保留（跟 ndc/parser.js 的约定一致）', () => {
  const d = describeMessage('4' + FS + '000' + FS + FS + '001');
  assert.deepStrictEqual(d.fields, ['4', '000', '', '001']);
});
