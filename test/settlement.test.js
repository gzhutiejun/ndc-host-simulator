const test = require('node:test');
const assert = require('node:assert');
const makeSettlement = require('../src/handlers/settlement');
const { matches } = require('../src/engine');
const { FS } = require('../src/constants');
const config = require('../config-ndc-vm.json');

const req = (opcode, mcn = '7') => ({
  messageClass: '1', subClass: '1', luno: '000',
  fields: ['11', '000', '', '', '1' + mcn, ';X=X?', '', opcode],
});

test('JA 应答：功能标识 5、next state 001、CC= 7×5 位、凭条回显 MCN', () => {
  const { settlement } = makeSettlement();
  const f = settlement(req('JA      ')).split(FS);
  assert.strictEqual(f[0], '4');
  assert.strictEqual(f[3], '001');
  assert.ok(f[5].startsWith('22355000CC=02000'));
  assert.strictEqual(f[5].slice('22355000CC='.length).length, 35);
  assert.ok(f[6].startsWith('703'));
});

test('JC 不带 CC=；无库时正文是 SETTLEMENT <操作码>', () => {
  const { settlement } = makeSettlement();
  const f = settlement(req('JC      ')).split(FS);
  assert.strictEqual(f[5], '22355000');
  assert.strictEqual(f[6], '703SETTLEMENT JC');
});

test('库里有 "JC" 条目时正文取自它', () => {
  const payload = ['4', '000', '', '001', '0', '2235', '003BODY-FROM-LIB'].join(FS);
  const { settlement } = makeSettlement({}, { library: [{ key: 'JC', payload }] });
  assert.strictEqual(settlement(req('JC      ', '3')).split(FS)[6], '303BODY-FROM-LIB');
});

test('配置覆盖 nextState / functionId', () => {
  const { settlement } = makeSettlement({ nextState: '123', functionId: '4' });
  const f = settlement(req('JD      ')).split(FS);
  assert.strictEqual(f[3], '123');
  assert.ok(f[5].startsWith('22354000'));
});

test('规则匹配：C A、JH  A   、JG  G   命中；JZ 不命中', () => {
  const rule = config.rules.find((r) => r.name === 'settlement-request');
  for (const op of ['C A     ', 'JH  A   ', 'JG  G   ', 'JI  C   ', 'JS      ', 'JN      ', 'JF      ']) {
    assert.strictEqual(matches(rule.match, req(op)), true, op);
  }
  assert.strictEqual(matches(rule.match, req('JZ      ')), false);
  assert.strictEqual(matches(rule.match, req('JH  H   ')), false);
});

test('settlementGis：缺省返回 GIS 帧，autoGisOnP20:false 返回 null', () => {
  const helpers = { applyTemplate: (t) => t.replace(/<FS>/g, FS), ctx: {} };
  assert.strictEqual(makeSettlement().settlementGis({}, null, helpers), '1' + FS + FS + FS + '1');
  assert.strictEqual(makeSettlement({ autoGisOnP20: false }).settlementGis({}, null, helpers), null);
});
