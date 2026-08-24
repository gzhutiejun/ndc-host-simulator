const test = require('node:test');
const assert = require('node:assert');
const { buildDdcTransactionReply, buildDdcEmvSegment } = require('../src/ndc/ddcTransactionReply');
const { FS } = require('../src/constants');

// 字段形状与标准 NDC 的 buildTransactionReply 一致：[4, luno, stn, nextState, fieldG,
// screen, printer]（可选 cam）——CUBC/DDC 的差别在扇区 7 起可以跨多段、以含 '9' 的段收尾
// （acc-cubc 的 ddc-reply-sectors.ts），单段 printer、无 EMV 段是这条规则的合法简单形态，
// 所以第一版复用同样的字段形状即可。

test('builds a minimal DDC reply without CAM', () => {
  const out = buildDdcTransactionReply({
    luno: '044', nextState: '803', fieldG: '',
    screen: '', printer: '',
  });
  assert.strictEqual(out, ['4', '044', '', '803', '', '', ''].join(FS));
});

test('honours explicit stn', () => {
  const out = buildDdcTransactionReply({ luno: '044', stn: '7', nextState: '803', fieldG: '' });
  assert.strictEqual(out, ['4', '044', '7', '803', '', '', ''].join(FS));
});

test('appends an EMV segment when provided (multi-segment DDC printer shape)', () => {
  const out = buildDdcTransactionReply({
    luno: '044', nextState: '128', fieldG: '00030000',
    screen: 'SCR', printer: '501RCPT', cam: "'9''M'0016B64C",
  });
  assert.strictEqual(
    out,
    ['4', '044', '', '128', '00030000', 'SCR', '501RCPT', "'9''M'0016B64C"].join(FS),
  );
});

// buildDdcEmvSegment：DDC 应答里的 EMV 段构造。现网样本形状是
// `'9''M'0016B64CEDA6008000000000123230373730`——`'9'` 是 acc-cubc 的
// ddc-reply-sectors.ts 认的 EMV 边界标记，`'M'` 紧随其后。内层十六进制数据的字段级
// 含义未核实（本仓库 acc-cubc 自己也没有消费点——见 ndc-codec.ts 的 reply.cam 从不
// 被下游读取），所以这里只保证**外层形状**（两个引号标记 + 十六进制 arc），跟标准
// NDC 的 buildCam（'5CAM8A02'+hex(arc)）是同一条纪律：能让 ddcReplySectors() 正确
// 切段，不是字节级还原真实密文。

test('buildDdcEmvSegment: shape only, not a byte-accurate replica', () => {
  assert.strictEqual(buildDdcEmvSegment('00', true), "'9''M'3030");
  assert.strictEqual(buildDdcEmvSegment('00', false), null);
});

test('buildDdcEmvSegment output contains the boundary marker ddcReplySectors looks for', () => {
  assert.match(buildDdcEmvSegment('00', true), /'9'/);
});
