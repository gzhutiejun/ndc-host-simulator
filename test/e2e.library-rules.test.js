const test = require('node:test');
const assert = require('node:assert');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');
const { createApp } = require('../server');
const { FS } = require('../src/constants');
const { encodeLength, createDecoder } = require('../src/framing');

// server.js 端到端覆盖：验证「规则用 libraryKey 应答」这条新通道从 config 到 createApp() 到
// 真实 TCP 收发全程接线正确，并且钉住"坏配置在启动期就崩，而不是等 ATM 连上来才发现"——
// 这一条 src/engine.js 的单元测试已经覆盖了 createEngine() 这一层，这里额外覆盖
// server.js::createApp() 这一层（它负责把 config.messageLibrary 的路径变成 engine 拿到的
// library 数组），因为真实的失败路径是"进程启动时执行 createApp(config)"，不是直接调 createEngine()。

const RECORD_SIZE = 614;
const LENGTH_FIELD_SIZE = 4;
const KEY_FIELD_SIZE = 8;
const HEADER = 'M1187RESV\r\n';

function buildRecord(key, payload) {
  const lengthField = String(payload.length).padStart(LENGTH_FIELD_SIZE, '0');
  const keyField = key.padEnd(KEY_FIELD_SIZE, ' ');
  return (lengthField + keyField + payload).padEnd(RECORD_SIZE, ' ');
}

function writeLibraryFile(records) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ndc-lib-'));
  const file = path.join(dir, 'library.doc');
  fs.writeFileSync(file, HEADER + records.map(([k, p]) => buildRecord(k, p)).join(''), 'latin1');
  return file;
}

function sendAndAwaitReply(port, text, timeoutMs = 500) {
  return new Promise((resolve, reject) => {
    const decoder = createDecoder();
    const client = net.createConnection({ port }, () => {
      client.write(encodeLength(Buffer.from(text, 'latin1')));
    });
    const timer = setTimeout(() => { client.destroy(); resolve(null); }, timeoutMs);
    client.on('data', (d) => {
      const frames = decoder.push(d);
      if (frames.length) {
        clearTimeout(timer);
        resolve(frames[0].toString('latin1'));
        client.end();
      }
    });
    client.on('error', (err) => { clearTimeout(timer); reject(err); });
  });
}

const WITHDRAWAL_RULE = {
  name: 'withdrawal-request',
  match: { messageClass: '1', subClass: '1', field: { index: 7, startsWith: 'A' } },
  libraryKey: 'A A  A A',
};

test('createApp() 在启动期（不等 ATM 连上来）就因坏配置抛错：规则要 libraryKey，但没配 messageLibrary', () => {
  const capDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ndc-lib-nolib-'));
  assert.throws(
    () => createApp({ enableTLS: false, captureDir: capDir, rules: [WITHDRAWAL_RULE] /* 没有 messageLibrary */ }),
    /withdrawal-request.*unknown library key/,
  );
});

test('createApp() 在启动期就因坏配置抛错：配了 messageLibrary，但库里没有规则点名的那个 key', () => {
  const libraryFile = writeLibraryFile([['SOME OTHER', '4' + FS + '000' + FS + FS + '001']]);
  const capDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ndc-lib-wrongkey-'));
  assert.throws(
    () => createApp({ enableTLS: false, captureDir: capDir, messageLibrary: libraryFile, rules: [WITHDRAWAL_RULE] }),
    /withdrawal-request.*unknown library key.*A A  A A/,
  );
});

test('createApp() + 真实 TCP：libraryKey 规则命中后，ATM 收到的就是库里那条原始报文（不经 applyTemplate 改写）', async () => {
  const payload = '4' + FS + '000' + FS + FS + '001' + FS + '01000000' + FS + 'SCREEN' + FS + 'RECEIPT';
  const libraryFile = writeLibraryFile([['A A  A A', payload]]);
  const capDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ndc-lib-e2e-'));
  const app = createApp({
    enableTLS: false,
    captureDir: capDir,
    messageLibrary: libraryFile,
    rules: [WITHDRAWAL_RULE],
  });
  await new Promise((resolve) => app.server.listen(0, resolve));
  try {
    const port = app.server.address().port;
    const req = ['11', '000', '', '', '15', ';XXXX=XXXX?', '', 'ADC     ', '00000300'].join(FS);
    const reply = await sendAndAwaitReply(port, req);
    assert.strictEqual(reply, payload);
  } finally {
    await new Promise((resolve) => app.server.close(resolve));
  }
});
