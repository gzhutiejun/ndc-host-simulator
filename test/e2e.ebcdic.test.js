const test = require('node:test');
const assert = require('node:assert');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');
const { createApp } = require('../server');
const { FS } = require('../src/constants');
const { encodeLength, createDecoder } = require('../src/framing');
const { setTransmissionCode, getTransmissionCode } = require('../src/ebcdic');

/**
 * EBCDIC 传输码的端到端验证：客户端在**线缆上**说 EBCDIC，模拟器必须能解析出报文、
 * 匹配到规则、并用 EBCDIC 回应答。
 *
 * 这里刻意**不复用** framing.js 的 encodeWire/decodeWire —— 那样测的是"实现和自己
 * 一致"。客户端侧自带一份最小换码表（只覆盖本用例用到的字符），两边独立算出同一串
 * 字节才说明真的对上了。
 */
const CLIENT_MAP = {
  0x30: 0xf0, 0x31: 0xf1, 0x32: 0xf2, 0x33: 0xf3, 0x34: 0xf4,
  0x35: 0xf5, 0x36: 0xf6, 0x37: 0xf7, 0x38: 0xf8, 0x39: 0xf9,
  0x42: 0xc2, 0x45: 0xc5, 0x1c: 0x1c,
};
const CLIENT_UNMAP = Object.fromEntries(Object.entries(CLIENT_MAP).map(([a, e]) => [e, Number(a)]));

function toEbcdic(text) {
  return Buffer.from([...text].map((ch) => {
    const code = ch.charCodeAt(0);
    const mapped = CLIENT_MAP[code];
    assert.ok(mapped !== undefined, `测试用例的换码表缺 0x${code.toString(16)}`);
    return mapped;
  }));
}

function fromEbcdic(buf) {
  return [...buf].map((b) => {
    const mapped = CLIENT_UNMAP[b];
    assert.ok(mapped !== undefined, `应答里出现了测试换码表没有的字节 0x${b.toString(16)}`);
    return String.fromCharCode(mapped);
  }).join('');
}

function exchange(port, wireBytes, timeoutMs = 2000) {
  return new Promise((resolve, reject) => {
    const decoder = createDecoder();
    const client = net.createConnection({ port }, () => {
      client.write(encodeLength(wireBytes));
    });
    const timer = setTimeout(() => {
      client.destroy();
      resolve(null);
    }, timeoutMs);
    client.on('data', (d) => {
      const frames = decoder.push(d);
      if (frames.length) {
        clearTimeout(timer);
        resolve(frames[0]);
        client.end();
      }
    });
    client.on('error', (err) => { clearTimeout(timer); reject(err); });
  });
}

const RULES = [
  { name: 'powerup-go-in-service',
    match: { messageClass: '1', subClass: '2', field: { index: 3, startsWith: 'B' } },
    handler: 'goInService' },
  { name: 'unsolicited-status-no-reply',
    match: { messageClass: '1', subClass: '2' }, noReply: true },
];

function startApp(extra) {
  const capDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ndc-ebcdic-'));
  return createApp({ enableTLS: false, captureDir: capDir, rules: RULES, ...extra });
}

test.afterEach(() => setTransmissionCode('ASCII'));

test('配了 EBCDIC 时：收 EBCDIC 的上电报文，回 EBCDIC 的 Go in-service', async () => {
  const app = startApp({ transmissionCode: 'EBCDIC' });
  await new Promise((r) => app.server.listen(0, r));
  try {
    const request = toEbcdic('12' + FS + '000' + FS + FS + 'B0001');
    // 先钉住请求确实是 EBCDIC 的：'1' → F1，FS 仍是 1C
    assert.strictEqual(request[0], 0xf1);
    assert.strictEqual(request[2], 0x1c);

    const reply = await exchange(app.server.address().port, request);
    assert.ok(reply, '模拟器没有应答 —— 说明 EBCDIC 请求没被解析出来');
    // 应答在线缆上必须也是 EBCDIC：'1' → F1
    assert.strictEqual(reply[0], 0xf1);
    assert.strictEqual(fromEbcdic(reply), '1' + FS + FS + FS + '1');
  } finally {
    await new Promise((r) => app.server.close(r));
  }
});

test('配了 EBCDIC 时，ASCII 的请求匹配不到规则（不静默当成有效报文）', async () => {
  const app = startApp({ transmissionCode: 'EBCDIC' });
  await new Promise((r) => app.server.listen(0, r));
  try {
    const ascii = Buffer.from('12' + FS + '000' + FS + FS + 'B0001', 'latin1');
    assert.strictEqual(await exchange(app.server.address().port, ascii, 500), null);
  } finally {
    await new Promise((r) => app.server.close(r));
  }
});

test('不配 transmissionCode 时是 ASCII —— 出厂行为逐字节不变', async () => {
  const app = startApp({});
  assert.strictEqual(getTransmissionCode(), 'ASCII');
  await new Promise((r) => app.server.listen(0, r));
  try {
    const ascii = Buffer.from('12' + FS + '000' + FS + FS + 'B0001', 'latin1');
    const reply = await exchange(app.server.address().port, ascii);
    assert.strictEqual(reply.toString('latin1'), '1' + FS + FS + FS + '1');
  } finally {
    await new Promise((r) => app.server.close(r));
  }
});
