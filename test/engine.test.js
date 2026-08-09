const test = require('node:test');
const assert = require('node:assert');
const { applyTemplate, matches, createEngine } = require('../src/engine');
const { FS } = require('../src/constants');
const { parse } = require('../src/ndc/parser');
const { encodeText } = require('../src/framing');
const { createSession } = require('../src/session');

test('applyTemplate substitutes control chars and context', () => {
  const out = applyTemplate('1<FS><FS><FS>1', {});
  assert.strictEqual(out, '1' + FS + FS + FS + '1');
  const out2 = applyTemplate('L=<LUNO> T=<TVN>', { luno: '123', tvn: '7' });
  assert.strictEqual(out2, 'L=123 T=7');
});

test('matches checks class, subClass, type and field predicates', () => {
  const p = parse(encodeText('22' + FS + '123' + FS + FS + 'B0000'));
  assert.strictEqual(matches({ messageClass: '2' }, p), true);
  assert.strictEqual(matches({ messageClass: '1' }, p), false);
  assert.strictEqual(matches({ type: 'SolicitedStatus' }, p), true);
  assert.strictEqual(matches({ field: { index: 3, startsWith: 'B' } }, p), true);
  assert.strictEqual(matches({ field: { index: 3, equals: '9' } }, p), false);
  assert.strictEqual(matches({}, p), true);
});

test('respond picks first matching template rule', () => {
  const engine = createEngine({
    rules: [{ name: 'gis', match: { messageClass: '2', field: { index: 3, startsWith: '9' } }, template: '1<FS><FS><FS>1' }],
    handlers: {},
  });
  const p = parse(encodeText('22' + FS + '123' + FS + FS + '9'));
  const out = engine.respond(p, createSession());
  assert.strictEqual(out.payload, '1' + FS + FS + FS + '1');
  assert.strictEqual(out.rule, 'gis');
});

test('respond dispatches to a handler', () => {
  const engine = createEngine({
    rules: [{ name: 'h', match: { type: 'SolicitedStatus' }, handler: 'echoLuno' }],
    handlers: {
      echoLuno: (parsed, session, helpers) => helpers.applyTemplate('X<LUNO>', helpers.ctx),
    },
  });
  const p = parse(encodeText('22' + FS + '777' + FS + FS + '9'));
  const out = engine.respond(p, createSession());
  assert.strictEqual(out.payload, 'X777');
});

test('respond honours noReply rule (matched but silent)', () => {
  // 真实主机对 ReadyB 心跳不应答，但仍是"匹配到"，不能当未识别
  const engine = createEngine({
    rules: [{ name: 'ready-b-idle', match: { messageClass: '2', field: { index: 3, startsWith: 'B' } }, noReply: true }],
    handlers: {},
  });
  const p = parse(encodeText('22' + FS + '000' + FS + FS + 'B'));
  const out = engine.respond(p, createSession());
  assert.strictEqual(out.payload, null);
  assert.strictEqual(out.rule, 'ready-b-idle');
});

test('respond returns null rule when no rule matches (真正未识别)', () => {
  const engine = createEngine({ rules: [{ name: 'x', match: { messageClass: '9' }, template: 'Z' }], handlers: {} });
  const p = parse(encodeText('22' + FS + '123'));
  const out = engine.respond(p, createSession());
  assert.strictEqual(out.payload, null);
  assert.strictEqual(out.rule, null);
});

test('respond throws for a matched rule with no template, handler, or noReply', () => {
  const engine = createEngine({
    rules: [{ name: 'bad-rule', match: { messageClass: '2' } }],
    handlers: {},
  });
  const p = parse(encodeText('22' + FS + '123'));
  assert.throws(
    () => engine.respond(p, createSession()),
    /defines no template/
  );
});

test('respond injects an overridable now() into handler helpers', () => {
  const fixed = new Date('2026-07-05T09:52:00Z');
  const engine = createEngine({
    rules: [{ name: 'clock', match: { messageClass: '2' }, handler: 'clock' }],
    handlers: { clock: (parsed, session, helpers) => helpers.now().toISOString() },
    now: () => fixed,
  });
  const p = parse(encodeText('22' + FS + '000' + FS + FS + '9'));
  const out = engine.respond(p, createSession());
  assert.strictEqual(out.payload, '2026-07-05T09:52:00.000Z');
});

test('respond falls through to the next rule when a handler returns null', () => {
  const engine = createEngine({
    rules: [
      { name: 'a', match: { messageClass: '2' }, handler: 'nullH' },
      { name: 'b', match: { messageClass: '2' }, handler: 'okH' },
    ],
    handlers: { nullH: () => null, okH: () => 'REPLY' },
  });
  const p = parse(encodeText('22' + FS + '000'));
  const out = engine.respond(p, createSession());
  assert.strictEqual(out.payload, 'REPLY');
  assert.strictEqual(out.rule, 'b');
});

test('respond returns null payload with the last matched rule name when every handler returns null', () => {
  const engine = createEngine({
    rules: [
      { name: 'a', match: { messageClass: '2' }, handler: 'nullH' },
      { name: 'b', match: { messageClass: '2' }, handler: 'nullH' },
    ],
    handlers: { nullH: () => null },
  });
  const p = parse(encodeText('22' + FS + '000'));
  const out = engine.respond(p, createSession());
  assert.strictEqual(out.payload, null);
  assert.strictEqual(out.rule, 'b');
});

test('respond stops at a noReply rule and does not fall through to later rules', () => {
  let reached = false;
  const engine = createEngine({
    rules: [
      { name: 'silent', match: { messageClass: '2' }, noReply: true },
      { name: 'after', match: { messageClass: '2' }, handler: 'mark' },
    ],
    handlers: { mark: () => { reached = true; return 'X'; } },
  });
  const p = parse(encodeText('22' + FS + '000'));
  const out = engine.respond(p, createSession());
  assert.strictEqual(out.payload, null);
  assert.strictEqual(out.rule, 'silent');
  assert.strictEqual(reached, false);
});

// ---- 一次性手动覆盖（Task 2） ----

test('override: 未设置 nextResponse 时，respond 行为与改动前逐字节一致（默认路径不变）', () => {
  // 跟上面"respond picks first matching template rule"用的是同一条规则/同一个入站报文，
  // 只是这次引擎多了 setNextResponse 方法可用——但从没调用它。钉住：默认状态下多出来的
  // 覆盖检查是一个纯粹的 no-op 分支，结果必须跟没有这个方法时完全一样。
  const engine = createEngine({
    rules: [{ name: 'gis', match: { messageClass: '2', field: { index: 3, startsWith: '9' } }, template: '1<FS><FS><FS>1' }],
    handlers: {},
  });
  const p = parse(encodeText('22' + FS + '123' + FS + FS + '9'));
  const out = engine.respond(p, createSession());
  assert.strictEqual(out.payload, '1' + FS + FS + FS + '1');
  assert.strictEqual(out.rule, 'gis');
});

test('override: { payload } 原样作答一次，赢过所有规则，用完自动回到规则引擎', () => {
  const engine = createEngine({
    rules: [{ name: 'gis', match: { messageClass: '2', field: { index: 3, startsWith: '9' } }, template: '1<FS><FS><FS>1' }],
    handlers: {},
  });
  engine.setNextResponse({ payload: 'RAW-OVERRIDE' });
  const p = parse(encodeText('22' + FS + '123' + FS + FS + '9'));

  const first = engine.respond(p, createSession());
  assert.strictEqual(first.payload, 'RAW-OVERRIDE');
  assert.match(first.rule, /^override:/);

  // 一次性：第二条同样匹配 gis 规则的报文，覆盖已经用掉了，落回规则引擎。
  const second = engine.respond(p, createSession());
  assert.strictEqual(second.payload, '1' + FS + FS + FS + '1');
  assert.strictEqual(second.rule, 'gis');
});

test('override: { noReply: true } 让下一条入站报文不应答，且不算命中规则里的 noReply', () => {
  const engine = createEngine({
    rules: [{ name: 'gis', match: { messageClass: '2', field: { index: 3, startsWith: '9' } }, template: '1<FS><FS><FS>1' }],
    handlers: {},
  });
  engine.setNextResponse({ noReply: true });
  const p = parse(encodeText('22' + FS + '123' + FS + FS + '9'));
  const out = engine.respond(p, createSession());
  assert.strictEqual(out.payload, null);
  assert.strictEqual(out.rule, 'override:noReply');
});

test('override: { key } 从传入的 library 里查 payload 作答', () => {
  const engine = createEngine({
    rules: [],
    handlers: {},
    library: [{ key: 'GIS', payload: '1' + FS + FS + FS + '1' }],
  });
  engine.setNextResponse({ key: 'GIS' });
  const p = parse(encodeText('22' + FS + '123'));
  const out = engine.respond(p, createSession());
  assert.strictEqual(out.payload, '1' + FS + FS + FS + '1');
  assert.match(out.rule, /GIS/);
});

test('override: 未知 key 在 setNextResponse 时就抛错（而不是拖到下一条报文进来才失败）', () => {
  const engine = createEngine({ rules: [], handlers: {}, library: [{ key: 'GIS', payload: 'x' }] });
  assert.throws(() => engine.setNextResponse({ key: 'NOPE' }), /unknown library key/);
});

test('override: 无效形状（既不是 key/payload/noReply）在设置时就抛错', () => {
  const engine = createEngine({ rules: [], handlers: {} });
  assert.throws(() => engine.setNextResponse({}), /must be/);
});

test('override: setNextResponse(null) 撤销一个已设置但还没用掉的覆盖，不消耗报文', () => {
  const engine = createEngine({
    rules: [{ name: 'gis', match: { messageClass: '2', field: { index: 3, startsWith: '9' } }, template: '1<FS><FS><FS>1' }],
    handlers: {},
  });
  engine.setNextResponse({ payload: 'WOULD-HAVE-FIRED' });
  engine.setNextResponse(null);
  const p = parse(encodeText('22' + FS + '123' + FS + FS + '9'));
  const out = engine.respond(p, createSession());
  assert.strictEqual(out.payload, '1' + FS + FS + FS + '1');
  assert.strictEqual(out.rule, 'gis');
});

test('override: 赢过 noReply 规则本身也会匹配的报文——覆盖优先，noReply 规则完全不参与', () => {
  const engine = createEngine({
    rules: [{ name: 'ready-b-idle', match: { messageClass: '2', field: { index: 3, startsWith: 'B' } }, noReply: true }],
    handlers: {},
  });
  engine.setNextResponse({ payload: 'OVERRIDE-BEATS-NOREPLY' });
  const p = parse(encodeText('22' + FS + '000' + FS + FS + 'B'));
  const out = engine.respond(p, createSession());
  assert.strictEqual(out.payload, 'OVERRIDE-BEATS-NOREPLY');
  assert.match(out.rule, /^override:/);

  // 用掉之后，同一条 noReply 报文再来一次，才轮到规则引擎正常处理成 noReply。
  const second = engine.respond(p, createSession());
  assert.strictEqual(second.payload, null);
  assert.strictEqual(second.rule, 'ready-b-idle');
});

// ---- libraryKey 规则（config.json 里的规则用报文库应答，取代硬编码 handler） ----

test('libraryKey: 匹配到的规则直接用库里的原始报文作答，不套 applyTemplate', () => {
  const engine = createEngine({
    rules: [{ name: 'withdrawal-request', match: { messageClass: '1', subClass: '1' }, libraryKey: 'A A  A A' }],
    handlers: {},
    library: [{ key: 'A A  A A', payload: '4' + FS + '000' + FS + FS + '001' + FS + '01000000' }],
  });
  const p = parse(encodeText('11' + FS + '000' + FS + FS + '15'));
  const out = engine.respond(p, createSession());
  assert.strictEqual(out.payload, '4' + FS + '000' + FS + FS + '001' + FS + '01000000');
  assert.strictEqual(out.rule, 'withdrawal-request');
});

test('libraryKey: 规则点名的 key 不在已加载的库里——构造 engine 时就抛错，不等 respond()', () => {
  assert.throws(
    () => createEngine({
      rules: [{ name: 'withdrawal-request', match: {}, libraryKey: 'NOT IN LIBRARY' }],
      handlers: {},
      library: [{ key: 'A A  A A', payload: 'x' }],
    }),
    /withdrawal-request.*unknown library key.*NOT IN LIBRARY/,
  );
});

test('libraryKey: 压根没配库（library 为空数组）时同样在构造期抛错，而不是把没库当成"这条规则不用管"', () => {
  assert.throws(
    () => createEngine({
      rules: [{ name: 'withdrawal-request', match: {}, libraryKey: 'A A  A A' }],
      handlers: {},
      // library 省略 —— 默认空数组，等价于没配 messageLibrary 或加载失败降级
    }),
    /withdrawal-request.*unknown library key/,
  );
});

test('libraryKey: 校验只在构造期发生一次，respond() 不会因为反复调用而重复抛错/重新扫库', () => {
  const engine = createEngine({
    rules: [{ name: 'balance-inquiry', match: { messageClass: '1', subClass: '1' }, libraryKey: 'C A  A A' }],
    handlers: {},
    library: [{ key: 'C A  A A', payload: 'BALANCE-REPLY' }],
  });
  const p = parse(encodeText('11' + FS + '000' + FS + FS + '15'));
  assert.doesNotThrow(() => engine.respond(p, createSession()));
  assert.doesNotThrow(() => engine.respond(p, createSession()));
});

test('respond stops at the first handler that returns a payload (later rules untouched)', () => {
  let reached = false;
  const engine = createEngine({
    rules: [
      { name: 'first', match: { messageClass: '2' }, handler: 'okH' },
      { name: 'second', match: { messageClass: '2' }, handler: 'mark' },
    ],
    handlers: { okH: () => 'FIRST', mark: () => { reached = true; return 'SECOND'; } },
  });
  const p = parse(encodeText('22' + FS + '000'));
  const out = engine.respond(p, createSession());
  assert.strictEqual(out.payload, 'FIRST');
  assert.strictEqual(out.rule, 'first');
  assert.strictEqual(reached, false);
});
