const test = require('node:test');
const assert = require('node:assert');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');
const { createApp } = require('../server');
const { FS, GS } = require('../src/constants');
const { encodeLength, createDecoder } = require('../src/framing');

const RS = '\x1e';
const RULES = [{ name: 'unsolicited-status-no-reply', match: { messageClass: '1', subClass: '2' }, noReply: true }];

/** 扮终端：发 trigger，之后对主机每条报文回一条 22…（10 ; 回 counters），收到 10 1 / 10 2 为止。 */
function runDownload(trigger, counters) {
  const capDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ndc-ddc-dl-'));
  const app = createApp({ enableTLS: false, captureDir: capDir, rules: RULES, ddcDownload: { enabled: true } });
  return new Promise((resolve, reject) => {
    const srv = app.start(0);
    srv.on('listening', () => {
      const sock = net.connect(srv.address().port, '127.0.0.1');
      const decoder = createDecoder();
      const got = [];
      const send = (text) => sock.write(encodeLength(Buffer.from(text, 'latin1')));
      const finish = (err) => { sock.destroy(); srv.close(); err ? reject(err) : resolve(got); };
      const timer = setTimeout(() => finish(new Error(`timeout after ${got.length} frames`)), 5000);
      sock.on('connect', () => send(trigger));
      sock.on('data', (chunk) => {
        for (const f of decoder.push(chunk)) {
          const text = f.toString('latin1');
          got.push(text);
          const head = text.split(FS).slice(0, 4).join('|');
          if (head === '10|000|000|1' || head === '10|000|000|2') { clearTimeout(timer); return finish(); }
          if (head === '10|000|000|;') send(['22', 'CUB', '', '8', counters].join(FS));
          else if (head === '10|000|000|3') send(['22', 'CUB', '', '8', '<00470000'].join(FS));
          else send(['22', 'CUB', '', '9'].join(FS));
        }
      });
      sock.on('error', finish);
    });
  });
}

const GOOD = 'H' + GS + 'CR0100000' + GS + 'DI01' + RS + 'DABC' + RS + '00300002000050000300';

test('supervisor exit 12…300: the whole production download, one frame per reply, then 10 1', async () => {
  const got = await runDownload(['12', 'CUB', '', '300'].join(FS), GOOD);
  const heads = got.map((t) => t.split(FS).slice(0, 4).join('|'));
  assert.strictEqual(got.length, 74);
  assert.strictEqual(heads[0], '30|000|000|32');
  assert.deepStrictEqual(heads.slice(-4), ['30|000|000|16', '10|000|000|3', '10|000|000|;', '10|000|000|1']);
  assert.strictEqual(got[70].split(FS)[4], '0001');
});

test('power-up 12…1 with all cassettes unavailable: ends with 10 2', async () => {
  const got = await runDownload(['12', 'CUB', '', '1'].join(FS), 'H' + GS + 'CR0100000' + GS + 'DI01' + RS + '@@@@' + RS);
  assert.strictEqual(got[got.length - 1], ['10', '000', '000', '2'].join(FS));
});
