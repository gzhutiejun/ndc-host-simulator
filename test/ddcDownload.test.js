const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { decodeTokens, loadSequence, createDownload, isDownloadTrigger } = require('../src/ddcDownload');
const { FS, GS } = require('../src/constants');

const SEQ = path.join(__dirname, '..', 'messages', 'ddc-download-sequence.txt');
const RS = '\x1e';
const READY = { messageClass: '2', subClass: '2', fields: ['22', 'CUB', '', '9'] };

test('decodeTokens turns the trace notation into control characters', () => {
  assert.strictEqual(decodeTokens('30<FS>000<ESC>L000<FF><SI>@<US>x<RS>y<GS>'), '30' + FS + '000\x1bL000\x0c\x0f@\x1fx' + RS + 'y' + GS);
});

test('the production sequence: key, config, 28 states, 31 screens, 7 FIT, 2 EMV, config ID, 10 3, 10 ;', () => {
  const seq = loadSequence(SEQ);
  const kind = (m) => m.split(FS).slice(0, 4).join('|');
  assert.strictEqual(seq.length, 73);
  assert.strictEqual(kind(seq[0]), '30|000|000|32');
  assert.strictEqual(seq.filter((m) => kind(m) === '30|000|000|12').length, 28);
  assert.strictEqual(seq.filter((m) => kind(m) === '30|000|000|11').length, 31);
  assert.strictEqual(seq.filter((m) => kind(m) === '30|000|000|15').length, 7);
  assert.deepStrictEqual(seq.slice(-3).map(kind), ['30|000|000|16', '10|000|000|3', '10|000|000|;']);
});

test('triggers: power-up 12…1 and supervisor exit 12…300, nothing else', () => {
  const p = (status) => ({ messageClass: '1', subClass: '2', fields: ['12', 'CUB', '', status] });
  assert.ok(isDownloadTrigger(p('1')));
  assert.ok(isDownloadTrigger(p('300')));
  assert.ok(!isDownloadTrigger(p('360')));
  assert.ok(!isDownloadTrigger(p('B0001')));
});

test('one message per terminal reply, config ID counts up, then go in service after good counters', () => {
  const messages = ['30<FS>000<FS>000<FS>13<FS>x', '30<FS>000<FS>000<FS>16<FS>0047', '10<FS>000<FS>000<FS>;'].map(decodeTokens);
  const d = createDownload({ messages, configId: 46 });
  assert.strictEqual(d.start(), messages[0]);
  assert.strictEqual(d.next(READY), '30' + FS + '000' + FS + '000' + FS + '16' + FS + '0047');
  assert.strictEqual(d.next(READY), messages[2]);
  const counters = { messageClass: '2', subClass: '2', fields: ['22', 'CUB', '', '8', 'H' + GS + 'CR0100000' + GS + 'DI01' + RS + 'DABC' + RS + '0'] };
  assert.strictEqual(d.next(counters), '10' + FS + '000' + FS + '000' + FS + '1');
  assert.ok(d.done);
  const again = createDownload({ messages, configId: d.configId });
  again.start();
  assert.strictEqual(again.next(READY).split(FS)[4], '0048');
});

test('all cassettes unavailable (@@@@): the host keeps the terminal out of service with 10 2', () => {
  const d = createDownload({ messages: [decodeTokens('10<FS>000<FS>000<FS>;')], configId: 1 });
  d.start();
  const counters = { messageClass: '2', subClass: '2', fields: ['22', 'CUB', '', '8', 'H' + GS + 'CR0100000' + GS + 'DI01' + RS + '@@@@' + RS] };
  assert.strictEqual(d.next(counters), '10' + FS + '000' + FS + '000' + FS + '2');
});

test('replacing the FIT messages', () => {
  const messages = ['30<FS>000<FS>000<FS>13<FS>x', '30<FS>000<FS>000<FS>15<FS>a', '30<FS>000<FS>000<FS>15<FS>b', '10<FS>000<FS>000<FS>;'].map(decodeTokens);
  const d = createDownload({ messages, configId: 1, fitMessages: ['FIT1'] });
  assert.deepStrictEqual(d.messages, [messages[0], 'FIT1', messages[3]]);
});
