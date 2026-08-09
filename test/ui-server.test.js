const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');

const { createUiServer } = require('../src/ui-server');
const { createEngine } = require('../src/engine');
const { createApp } = require('../server');
const { FS, GS, RS, SO, SI } = require('../src/constants');
const { encodeLength, encodeText, createDecoder } = require('../src/framing');

// 这个文件覆盖 Task 3（HTTP 控制台）的 API 契约。明确不测页面渲染本身（GET / 只断言状态码/
// content-type），重点是：/api/library、/api/next、/api/push 的行为契约，和 —— 按要求
// "至少实打实跑一次" —— /api/stream 真的会推事件出来，不是个哑巴流。

// ---- 小工具：给 http.request 包一层 Promise，风格上跟仓库里其它 e2e 测试的裸 net/http 用法一致 ----
function request(port, method, urlPath, body) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? null : JSON.stringify(body);
    const headers = data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {};
    const req = http.request({ port, method, path: urlPath, headers }, (res) => {
      let raw = '';
      res.on('data', (chunk) => { raw += chunk; });
      res.on('end', () => {
        let parsed = null;
        try { parsed = raw ? JSON.parse(raw) : null; } catch { parsed = raw; }
        resolve({ status: res.statusCode, headers: res.headers, body: parsed });
      });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

// 把一条 text/event-stream 响应包成"要下一帧就 await sse.next()"，隐藏掉 SSE 用 \n\n 分帧、
// 以注释行(:开头)探活这些协议细节。
// 注意：两条紧挨着写的帧（比如同一条入站报文触发的 RECV 紧跟着 SEND）经常被合并进同一个
// TCP 段、同一个 'data' 事件——如果只在"已经有人在等"时才 resolve，第二条会被无声丢弃，
// 调用方的 sse.next() 永远等不到它。所以已到达但还没人要的帧要缓存进 pending 队列，
// next() 优先从队列里取，取不到才注册新等待者。
function collectSse(res) {
  let buf = '';
  const waiters = [];
  const pending = [];
  res.on('data', (chunk) => {
    buf += chunk.toString('utf8');
    let idx;
    while ((idx = buf.indexOf('\n\n')) !== -1) {
      const raw = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      if (raw.startsWith('data:')) {
        const frame = JSON.parse(raw.slice(5));
        if (waiters.length) waiters.shift()(frame);
        else pending.push(frame);
      }
    }
  });
  return {
    next: () => (pending.length ? Promise.resolve(pending.shift()) : new Promise((resolve) => waiters.push(resolve))),
  };
}

function openSse(port) {
  return new Promise((resolve, reject) => {
    const req = http.get({ port, path: '/api/stream' }, (res) => resolve({ req, res, sse: collectSse(res) }));
    req.on('error', reject);
  });
}

// ==================== 单元层：直接对 createUiServer() 发请求，不经过 server.js ====================

test('GET / 返回控制台页面（只断言状态码/content-type，不测渲染）', async () => {
  const engine = createEngine({ rules: [], handlers: {} });
  const ui = createUiServer({ engine });
  await new Promise((resolve) => ui.listen(0, resolve));
  const port = ui.server.address().port;
  try {
    const res = await request(port, 'GET', '/');
    assert.strictEqual(res.status, 200);
    assert.match(res.headers['content-type'], /text\/html/);
  } finally {
    await new Promise((resolve) => ui.close(resolve));
  }
});

test('GET /api/library 返回 key+label 的列表，不带 fields/payload', async () => {
  const engine = createEngine({ rules: [], handlers: {} });
  const library = [
    { key: 'GIS', payload: '1' + FS + FS + FS + '1' },
    { key: 'A A  A A', payload: '4' + FS + '000' + FS + FS + '001' + FS + '01000000' },
  ];
  const ui = createUiServer({ engine, library });
  await new Promise((resolve) => ui.listen(0, resolve));
  const port = ui.server.address().port;
  try {
    const res = await request(port, 'GET', '/api/library');
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.count, 2);
    assert.strictEqual(res.body.entries.length, 2);
    assert.strictEqual(res.body.entries[0].key, 'GIS');
    assert.strictEqual(res.body.entries[0].label, '终端命令 · Go In Service');
    assert.strictEqual(res.body.entries[1].key, 'A A  A A');
    assert.match(res.body.entries[1].label, /交易应答/);
    // 不该把 fields/payload 一起吐出来（1000+ 条时没必要，选中靠 key 让 engine 去查）
    assert.strictEqual(res.body.entries[0].fields, undefined);
    assert.strictEqual(res.body.entries[0].payload, undefined);
  } finally {
    await new Promise((resolve) => ui.close(resolve));
  }
});

test('未知路由返回 404', async () => {
  const engine = createEngine({ rules: [], handlers: {} });
  const ui = createUiServer({ engine });
  await new Promise((resolve) => ui.listen(0, resolve));
  const port = ui.server.address().port;
  try {
    const res = await request(port, 'GET', '/api/nope');
    assert.strictEqual(res.status, 404);
  } finally {
    await new Promise((resolve) => ui.close(resolve));
  }
});

test('POST /api/next: {key} 武装覆盖，engine 下一条 respond 就用它', async () => {
  const engine = createEngine({
    rules: [],
    handlers: {},
    library: [{ key: 'GIS', payload: '1' + FS + FS + FS + '1' }],
  });
  const ui = createUiServer({ engine });
  await new Promise((resolve) => ui.listen(0, resolve));
  const port = ui.server.address().port;
  try {
    const res = await request(port, 'POST', '/api/next', { key: 'GIS' });
    assert.strictEqual(res.status, 200);
    assert.deepStrictEqual(res.body.armed, { key: 'GIS' });

    const { parse } = require('../src/ndc/parser');
    const { createSession } = require('../src/session');
    const out = engine.respond(parse(encodeText('22' + FS + '123')), createSession());
    assert.strictEqual(out.payload, '1' + FS + FS + FS + '1');
  } finally {
    await new Promise((resolve) => ui.close(resolve));
  }
});

test('POST /api/next: 未知 key 在设置时就 400，不静默武装', async () => {
  const engine = createEngine({ rules: [], handlers: {}, library: [{ key: 'GIS', payload: 'x' }] });
  const ui = createUiServer({ engine });
  await new Promise((resolve) => ui.listen(0, resolve));
  const port = ui.server.address().port;
  try {
    const res = await request(port, 'POST', '/api/next', { key: 'NOPE' });
    assert.strictEqual(res.status, 400);
    assert.match(res.body.error, /unknown library key/);
  } finally {
    await new Promise((resolve) => ui.close(resolve));
  }
});

test('POST /api/next: 空 body 清除已武装的覆盖', async () => {
  const engine = createEngine({ rules: [], handlers: {} });
  const ui = createUiServer({ engine });
  await new Promise((resolve) => ui.listen(0, resolve));
  const port = ui.server.address().port;
  try {
    const armed = await request(port, 'POST', '/api/next', { payload: 'X' });
    assert.strictEqual(armed.status, 200);
    const cleared = await request(port, 'POST', '/api/next'); // 没传 body
    assert.strictEqual(cleared.status, 200);
    assert.strictEqual(cleared.body.armed, null);
  } finally {
    await new Promise((resolve) => ui.close(resolve));
  }
});

test('POST /api/push: 没接 push handler 时返回 503（不是静默失败）', async () => {
  const engine = createEngine({ rules: [], handlers: {} });
  const ui = createUiServer({ engine }); // 没传 push
  await new Promise((resolve) => ui.listen(0, resolve));
  const port = ui.server.address().port;
  try {
    const res = await request(port, 'POST', '/api/push', { code: '1' });
    assert.strictEqual(res.status, 503);
  } finally {
    await new Promise((resolve) => ui.close(resolve));
  }
});

test('POST /api/push: 缺 code 返回 400', async () => {
  const engine = createEngine({ rules: [], handlers: {} });
  const ui = createUiServer({ engine, push: () => ({ sent: 1 }) });
  await new Promise((resolve) => ui.listen(0, resolve));
  const port = ui.server.address().port;
  try {
    const res = await request(port, 'POST', '/api/push', { luno: '000' });
    assert.strictEqual(res.status, 400);
  } finally {
    await new Promise((resolve) => ui.close(resolve));
  }
});

test('POST /api/push: 调用注入的 push handler 并透传其返回值', async () => {
  const engine = createEngine({ rules: [], handlers: {} });
  const calls = [];
  const ui = createUiServer({ engine, push: (spec) => { calls.push(spec); return { sent: 3 }; } });
  await new Promise((resolve) => ui.listen(0, resolve));
  const port = ui.server.address().port;
  try {
    const res = await request(port, 'POST', '/api/push', { code: '1', luno: '000' });
    assert.strictEqual(res.status, 200);
    assert.deepStrictEqual(res.body, { sent: 3 });
    assert.strictEqual(calls.length, 1);
    assert.strictEqual(calls[0].code, '1');
  } finally {
    await new Promise((resolve) => ui.close(resolve));
  }
});

test('GET /api/stream: publish() 广播的帧经过控制字符渲染后送达客户端（流不是哑的）', async () => {
  const engine = createEngine({ rules: [], handlers: {} });
  const ui = createUiServer({ engine });
  await new Promise((resolve) => ui.listen(0, resolve));
  const port = ui.server.address().port;
  try {
    const { sse, req } = await openSse(port);
    const framePromise = sse.next();

    // 用真实五个控制字符拼一条载荷，钉住 constants.js 里的映射（本仓 SO=0x0e/SI=0x0f）
    // 渲染到 plan 订正后的符号：FS→| GS→~ RS→^ SO→< SI→>。
    const raw = 'A' + FS + 'B' + GS + 'C' + RS + 'D' + SO + 'E' + SI + 'F';
    ui.publish('RECV', Buffer.from(raw, 'latin1'), { type: 'TestType', rule: 'test-rule' });

    const frame = await framePromise;
    assert.strictEqual(frame.direction, 'RECV');
    assert.strictEqual(frame.bytes, Buffer.byteLength(raw, 'latin1'));
    assert.strictEqual(frame.type, 'TestType');
    assert.strictEqual(frame.rule, 'test-rule');
    assert.strictEqual(frame.text, 'A|B~C^D<E>F');
    assert.deepStrictEqual(frame.fields, ['A', 'B~C^D<E>F']);

    req.destroy();
  } finally {
    await new Promise((resolve) => ui.close(resolve));
  }
});

// ==================== 集成层：经 server.js / createApp() 布线 ====================

test('createApp: 不配 uiPort 时 app.ui 为 null —— 从未调用 http.createServer，不止是没监听', () => {
  const capDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ndc-ui-off-'));
  const app1 = createApp({ enableTLS: false, captureDir: capDir, rules: [] });
  assert.strictEqual(app1.ui, null);

  const app2 = createApp({ enableTLS: false, captureDir: capDir, rules: [], uiPort: 0 });
  assert.strictEqual(app2.ui, null);

  const app3 = createApp({ enableTLS: false, captureDir: capDir, rules: [], uiPort: false });
  assert.strictEqual(app3.ui, null);
});

test('createApp: 配了 uiPort 时暴露 app.ui，且不影响 NDC 端口(app.server)照常工作', async () => {
  const capDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ndc-ui-on-'));
  const app = createApp({
    enableTLS: false,
    captureDir: capDir,
    rules: [{ name: 'gis', match: { messageClass: '2', field: { index: 3, startsWith: '9' } }, template: '1<FS><FS><FS>1' }],
    uiPort: 1, // 只用来打开 app.ui 这个对象；测试自己用 listen(0,...) 挑随机端口，跟 config.port 无关
  });
  assert.notStrictEqual(app.ui, null);

  await new Promise((resolve) => app.server.listen(0, resolve));
  await new Promise((resolve) => app.ui.listen(0, resolve));
  try {
    const ndcPort = app.server.address().port;
    const decoder = createDecoder();
    const reply = await new Promise((resolve, reject) => {
      const client = net.createConnection({ port: ndcPort }, () => {
        client.write(encodeLength(Buffer.from('22' + FS + '123' + FS + FS + '9', 'latin1')));
      });
      client.on('data', (d) => {
        const frames = decoder.push(d);
        if (frames.length) { resolve(frames[0].toString('latin1')); client.end(); }
      });
      client.on('error', reject);
    });
    assert.strictEqual(reply, '1' + FS + FS + FS + '1');

    const uiPort = app.ui.server.address().port;
    const lib = await request(uiPort, 'GET', '/api/library');
    assert.strictEqual(lib.status, 200);
  } finally {
    await new Promise((resolve) => app.server.close(resolve));
    await new Promise((resolve) => app.ui.close(resolve));
  }
});

test('server.js: POST /api/push 经真实 TCP 活跃连接把终端命令送到 ATM', async () => {
  const capDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ndc-ui-push-'));
  const app = createApp({ enableTLS: false, captureDir: capDir, rules: [], uiPort: 1 });

  await new Promise((resolve) => app.server.listen(0, resolve));
  await new Promise((resolve) => app.ui.listen(0, resolve));
  const ndcPort = app.server.address().port;
  const uiPort = app.ui.server.address().port;

  const client = net.createConnection({ port: ndcPort });
  await new Promise((resolve, reject) => { client.on('connect', resolve); client.on('error', reject); });

  const decoder = createDecoder();
  const pushed = new Promise((resolve) => {
    client.on('data', (d) => {
      const frames = decoder.push(d);
      if (frames.length) resolve(frames[0].toString('latin1'));
    });
  });

  try {
    const res = await request(uiPort, 'POST', '/api/push', { code: '1', luno: '000' });
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.sent, 1);

    const text = await pushed;
    assert.strictEqual(text, '1' + FS + '000' + FS + FS + '1');
  } finally {
    client.destroy();
    await new Promise((resolve) => app.server.close(resolve));
    await new Promise((resolve) => app.ui.close(resolve));
  }
});

test('server.js: 真实 TCP 收发的帧经 SSE 推给控制台（端到端，不只是单元层 publish()）', async () => {
  const capDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ndc-ui-sse-'));
  const app = createApp({
    enableTLS: false,
    captureDir: capDir,
    rules: [{ name: 'gis', match: { messageClass: '2', field: { index: 3, startsWith: '9' } }, template: '1<FS><FS><FS>1' }],
    uiPort: 1,
  });

  await new Promise((resolve) => app.server.listen(0, resolve));
  await new Promise((resolve) => app.ui.listen(0, resolve));
  const ndcPort = app.server.address().port;
  const uiPort = app.ui.server.address().port;

  const { sse, req: sseReq } = await openSse(uiPort);
  const recvPromise = sse.next();

  const client = net.createConnection({ port: ndcPort });
  await new Promise((resolve, reject) => { client.on('connect', resolve); client.on('error', reject); });

  try {
    client.write(encodeLength(Buffer.from('22' + FS + '123' + FS + FS + '9', 'latin1')));

    const recvFrame = await recvPromise;
    assert.strictEqual(recvFrame.direction, 'RECV');
    assert.strictEqual(recvFrame.rule, 'gis');
    assert.strictEqual(recvFrame.text, '22|123||9');

    const sendFrame = await sse.next();
    assert.strictEqual(sendFrame.direction, 'SEND');
    assert.strictEqual(sendFrame.rule, 'gis');
    assert.strictEqual(sendFrame.text, '1|||1');
  } finally {
    sseReq.destroy();
    client.destroy();
    await new Promise((resolve) => app.server.close(resolve));
    await new Promise((resolve) => app.ui.close(resolve));
  }
});
