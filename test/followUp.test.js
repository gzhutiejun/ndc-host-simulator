const test = require('node:test');
const assert = require('node:assert');
const { rememberOriginal, isStrippedFollowUp, rehydrate, clearOriginal } = require('../src/ndc/followUp');

const ORIGINAL = ['11', '000', '', '', '13', ';1234=56?', 'T3', 'A A  A A', '00010000', 'PINA', '', 'BUFC'];
const stripped = (b, mcn = '4') => ({ fields: ['11', '000', '', '', '1' + mcn, '', '', '', '', '', b, ''] });

test('followUp: 没存底时 isStrippedFollowUp 为 false', () => {
  assert.strictEqual(isStrippedFollowUp(stripped('A'), {}), false);
});

test('followUp: 存底后剥过的跟进被认出；首条形态（opcode 非空）不算', () => {
  const session = {};
  rememberOriginal(session, ORIGINAL);
  assert.deepStrictEqual(session.hostSelectionOriginal, ORIGINAL);
  assert.notStrictEqual(session.hostSelectionOriginal, ORIGINAL);
  assert.strictEqual(isStrippedFollowUp(stripped('A'), session), true);
  assert.strictEqual(isStrippedFollowUp({ fields: ORIGINAL.slice() }, session), false);
});

test('followUp: mergeConfirmation 补过的跟进（带 confirmationKey）也算', () => {
  const session = {};
  rememberOriginal(session, ORIGINAL);
  assert.strictEqual(isStrippedFollowUp({ fields: ORIGINAL.slice(), confirmationKey: 'A' }, session), true);
});

test('followUp: rehydrate generic 补回段 5–9，段 11 不动，清存底', () => {
  const session = {};
  rememberOriginal(session, ORIGINAL);
  const parsed = stripped('A');
  rehydrate(parsed, session, 'generic');
  assert.deepStrictEqual(parsed.fields.slice(5, 10), ORIGINAL.slice(5, 10));
  assert.strictEqual(parsed.fields[4], '14');
  assert.strictEqual(parsed.fields[10], 'A');
  assert.strictEqual(parsed.fields[11], '');
  assert.strictEqual(session.hostSelectionOriginal, undefined);
});

test('followUp: rehydrate oar 另补段 11', () => {
  const session = {};
  rememberOriginal(session, ORIGINAL);
  const parsed = stripped('2');
  rehydrate(parsed, session, 'oar');
  assert.deepStrictEqual(parsed.fields.slice(5, 10), ORIGINAL.slice(5, 10));
  assert.strictEqual(parsed.fields[11], 'BUFC');
  assert.strictEqual(parsed.fields[10], '2');
});

test('followUp: clearOriginal 清存底', () => {
  const session = {};
  rememberOriginal(session, ORIGINAL);
  clearOriginal(session);
  assert.strictEqual(isStrippedFollowUp(stripped('A'), session), false);
});
