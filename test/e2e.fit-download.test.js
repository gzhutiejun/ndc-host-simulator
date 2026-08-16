const test = require('node:test');
const assert = require('node:assert');
const net = require('node:net');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');
const { createApp } = require('../server');
const { FS } = require('../src/constants');
const { encodeLength, createDecoder } = require('../src/framing');

// 报文库 key = "FIT" 那条真实样本里的 FIT 条目，35 字节写成 105 位十进制。
const FIT_ENTRY =
  '023000255255255255255002000132000015000031138255007001035069103137001035069' +
  '000000000000000000000000064064064000000000';

const FIT_CONFIG = { luno: '218', msn: '000', responseFlag: '0', entries: [FIT_ENTRY] };
const EXPECTED_FIT_FRAME = '30' + FS + '218' + FS + '000' + FS + '15' + FS + FIT_ENTRY + FS;
const EXPECTED_GIS_FRAME = '1' + FS + FS + FS + '1';

const POWERUP_FRAME = '12' + FS + '000' + FS + FS + 'B0001';

const RULES = [
  { name: 'powerup-go-in-service',
    match: { messageClass: '1', subClass: '2', field: { index: 3, startsWith: 'B' } },
    handler: 'goInService' },
  { name: 'unsolicited-status-no-reply',
    match: { messageClass: '1', subClass: '2' }, noReply: true },
];

function startApp(extra) {
  const capDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ndc-fit-'));
  return createApp(Object.assign({ enableTLS: false, captureDir: capDir, rules: RULES }, extra));
}

function postJson(port, urlPath, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = http.request(
      { port, method: 'POST', path: urlPath, headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } },
      (res) => {
        let raw = '';
        res.on('data', (c) => { raw += c; });
        res.on('end', () => resolve({ status: res.statusCode, body: raw ? JSON.parse(raw) : null }));
      },
    );
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

/**
 * 连上去、发一帧、把 windowMs 之内收到的**所有**帧按顺序收齐。
 * 不能只收第一帧——本用例的重点恰恰是"发了几帧、顺序如何"。
 */
function collectFrames(port, toSend, windowMs = 800) {
  return new Promise((resolve, reject) => {
    const decoder = createDecoder();
    const got = [];
    const client = net.createConnection({ port }, () => {
      if (toSend) client.write(encodeLength(Buffer.from(toSend, 'latin1')));
    });
    client.on('data', (d) => {
      for (const frame of decoder.push(d)) got.push(frame.toString('latin1'));
    });
    client.on('error', (err) => { clearTimeout(timer); reject(err); });
    const timer = setTimeout(() => { client.destroy(); resolve(got); }, windowMs);
  });
}

test('POST /api/push {type:"fit"} 把 config.fitDownload 拼成的 FIT 帧送到活跃连接', async () => {
  const app = startApp({ uiPort: 1, fitDownload: FIT_CONFIG });
  await new Promise((r) => app.server.listen(0, r));
  await new Promise((r) => app.ui.listen(0, r));

  const decoder = createDecoder();
  const client = net.createConnection({ port: app.server.address().port });
  await new Promise((resolve, reject) => { client.on('connect', resolve); client.on('error', reject); });
  const pushed = new Promise((resolve) => {
    client.on('data', (d) => {
      const frames = decoder.push(d);
      if (frames.length) resolve(frames[0].toString('latin1'));
    });
  });

  try {
    const res = await postJson(app.ui.server.address().port, '/api/push', { type: 'fit' });
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.sent, 1);
    assert.strictEqual(await pushed, EXPECTED_FIT_FRAME);
  } finally {
    client.destroy();
    await new Promise((r) => app.server.close(r));
    await new Promise((r) => app.ui.close(r));
  }
});

test('POST /api/push {type:"fit"} 的 entries 可以就地覆盖配置里的条目', async () => {
  const app = startApp({ uiPort: 1, fitDownload: FIT_CONFIG });
  await new Promise((r) => app.server.listen(0, r));
  await new Promise((r) => app.ui.listen(0, r));

  const decoder = createDecoder();
  const client = net.createConnection({ port: app.server.address().port });
  await new Promise((resolve, reject) => { client.on('connect', resolve); client.on('error', reject); });
  const pushed = new Promise((resolve) => {
    client.on('data', (d) => {
      const frames = decoder.push(d);
      if (frames.length) resolve(frames[0].toString('latin1'));
    });
  });

  try {
    await postJson(app.ui.server.address().port, '/api/push', { type: 'fit', entries: ['000255'], luno: '001' });
    assert.strictEqual(await pushed, '30' + FS + '001' + FS + '000' + FS + '15' + FS + '000255' + FS);
  } finally {
    client.destroy();
    await new Promise((r) => app.server.close(r));
    await new Promise((r) => app.ui.close(r));
  }
});

test('POST /api/push {type:"fit"} 在坏条目上返回 400，不往 ATM 发半条报文', async () => {
  const app = startApp({ uiPort: 1, fitDownload: FIT_CONFIG });
  await new Promise((r) => app.server.listen(0, r));
  await new Promise((r) => app.ui.listen(0, r));
  try {
    const res = await postJson(app.ui.server.address().port, '/api/push', { type: 'fit', entries: ['12A'] });
    assert.strictEqual(res.status, 400);
  } finally {
    await new Promise((r) => app.server.close(r));
    await new Promise((r) => app.ui.close(r));
  }
});

test('beforeGoInService 打开时，上电报文先收到 FIT、再收到 Go In Service', async () => {
  const app = startApp({
    fitDownload: Object.assign({ beforeGoInService: true, delayMs: 20 }, FIT_CONFIG),
  });
  await new Promise((r) => app.server.listen(0, r));
  try {
    const frames = await collectFrames(app.server.address().port, POWERUP_FRAME);
    assert.deepStrictEqual(frames, [EXPECTED_FIT_FRAME, EXPECTED_GIS_FRAME]);
  } finally {
    await new Promise((r) => app.server.close(r));
  }
});

test('beforeGoInService 缺省（关）时上电只收到 Go In Service —— 出厂行为不变', async () => {
  const app = startApp({ fitDownload: FIT_CONFIG });
  await new Promise((r) => app.server.listen(0, r));
  try {
    const frames = await collectFrames(app.server.address().port, POWERUP_FRAME);
    assert.deepStrictEqual(frames, [EXPECTED_GIS_FRAME]);
  } finally {
    await new Promise((r) => app.server.close(r));
  }
});

test('beforeGoInService 打开时，非上电报文（不走 goInService 的规则）不会捎带 FIT', async () => {
  const app = startApp({
    rules: [
      { name: 'unsolicited-status-no-reply', match: { messageClass: '1', subClass: '2' }, noReply: true },
    ],
    fitDownload: Object.assign({ beforeGoInService: true, delayMs: 20 }, FIT_CONFIG),
  });
  await new Promise((r) => app.server.listen(0, r));
  try {
    const frames = await collectFrames(app.server.address().port, POWERUP_FRAME);
    assert.deepStrictEqual(frames, []);
  } finally {
    await new Promise((r) => app.server.close(r));
  }
});

test('FIT 帧落进抓包日志，rule 标注得出是哪条路径发的', async () => {
  const capDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ndc-fit-log-'));
  const app = createApp({
    enableTLS: false,
    captureDir: capDir,
    rules: RULES,
    fitDownload: Object.assign({ beforeGoInService: true, delayMs: 20 }, FIT_CONFIG),
  });
  await new Promise((r) => app.server.listen(0, r));
  try {
    await collectFrames(app.server.address().port, POWERUP_FRAME);
    const logFile = fs.readdirSync(capDir).find((f) => f.endsWith('.log'));
    assert.ok(logFile, '应当写出一个 capture 日志');
    const text = fs.readFileSync(path.join(capDir, logFile), 'utf8');
    assert.match(text, /fitDownload:beforeGoInService/);
  } finally {
    await new Promise((r) => app.server.close(r));
  }
});
