const test = require('node:test');
const assert = require('node:assert');
const { buildEki, kvv } = require('../src/ndc/eki');

const MASTER = '0123456789ABCDEFFEDCBA9876543210';
const NEW = '11111111111111112222222222222222';

test('buildEki: 子类 3 修饰符 2 的测试向量', () => {
  const r = buildEki({ subclass: '3', modifier: '2', masterKey: MASTER, newKey: NEW });
  assert.strictEqual(r.identifier, '32');
  assert.strictEqual(r.data, '155058123136058016015115180171162187121028080231');
  assert.strictEqual(r.expectedKvv, 'D2B91C');
});

test('buildEki: 子类 4 数据以 030 开头', () => {
  const r = buildEki({ subclass: '4', modifier: '1', masterKey: MASTER, newKey: NEW });
  assert.strictEqual(r.identifier, '41');
  assert.ok(r.data.startsWith('030'));
  assert.strictEqual(r.data.slice(3), '155058123136058016015115180171162187121028080231');
});

test('buildEki: 单倍长 newKey 前缀 018、数据 24 位', () => {
  const r = buildEki({ subclass: '4', modifier: '1', masterKey: MASTER, newKey: '1111111111111111' });
  assert.ok(r.data.startsWith('018'));
  assert.strictEqual(r.data.length, 3 + 24);
  const r3 = buildEki({ subclass: '3', modifier: '1', masterKey: MASTER, newKey: '1111111111111111' });
  assert.strictEqual(r3.data.length, 24);
});

test('kvv: 主密钥自身 KVV', () => {
  assert.strictEqual(kvv(MASTER), '08D7B4');
});

test('buildEki: 坏参数抛错', () => {
  assert.throws(() => buildEki({ subclass: '3', modifier: '1', masterKey: '', newKey: NEW }));
  assert.throws(() => buildEki({ subclass: '3', modifier: '1', masterKey: MASTER, newKey: '1234' }));
  assert.throws(() => buildEki({ subclass: '5', modifier: '1', masterKey: MASTER, newKey: NEW }));
});
