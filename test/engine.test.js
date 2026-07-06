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
