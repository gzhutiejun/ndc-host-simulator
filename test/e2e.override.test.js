const test = require('node:test');
const assert = require('node:assert');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');
const { createApp } = require('../server');
const { FS } = require('../src/constants');
const { encodeLength, createDecoder } = require('../src/framing');

// server.js 端到端覆盖测试：验证 Task 2 加到 server.js 里的两处布线——
//   1) createApp() 把 engine 实例挂在返回值上，供 Task 3 的 HTTP 控制台调用
//      engine.setNextResponse(...)；
//   2) config.messageLibrary 的加载/降级逻辑（不配 = 空库；配了但读不到 = 记日志降级，
//      不让服务起不来）。
// 这两处都不是 src/engine.js 单元测试能覆盖到的，所以单开一个 e2e 文件，风格照抄
// e2e.push-on-connect.test.js。

function sendAndAwaitReply(port, text) {
  return new Promise((resolve, reject) => {
    const decoder = createDecoder();
    const client = net.createConnection({ port }, () => {
      client.write(encodeLength(Buffer.from(text, 'latin1')));
    });
    const timer = setTimeout(() => {
      client.destroy();
      resolve(null); // 超时当"没回"，调用方按需断言
    }, 500);
    client.on('data', (d) => {
      const frames = decoder.push(d);
      if (frames.length) {
        clearTimeout(timer);
        resolve(frames[0].toString('latin1'));
        client.end();
      }
    });
    client.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

test('createApp() 暴露 engine，且不配 messageLibrary/未调用 setNextResponse 时行为与改动前逐字节一致', async () => {
  const capDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ndc-override-default-'));
  const app = createApp({
    enableTLS: false,
    captureDir: capDir,
    rules: [{ name: 'ready9-go-in-service', match: { messageClass: '2', field: { index: 3, startsWith: '9' } }, handler: 'goInService' }],
  });
  assert.strictEqual(typeof app.engine, 'object');
  assert.strictEqual(typeof app.engine.setNextResponse, 'function');

  await new Promise((resolve) => app.server.listen(0, resolve));
  const port = app.server.address().port;
  try {
    const reply = await sendAndAwaitReply(port, '22' + FS + '123' + FS + FS + '9');
    assert.strictEqual(reply, '1' + FS + FS + FS + '1'); // 跟 test/e2e.test.js 里的期望值一模一样
  } finally {
    await new Promise((resolve) => app.server.close(resolve));
  }
});

test('engine.setNextResponse 通过 TCP 生效一次，随后自动回落到规则引擎', async () => {
  const capDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ndc-override-once-'));
  const app = createApp({
    enableTLS: false,
    captureDir: capDir,
    rules: [{ name: 'ready9-go-in-service', match: { messageClass: '2', field: { index: 3, startsWith: '9' } }, handler: 'goInService' }],
  });
  app.engine.setNextResponse({ payload: 'HELLO-FROM-CONSOLE' });

  await new Promise((resolve) => app.server.listen(0, resolve));
  const port = app.server.address().port;
  try {
    const first = await sendAndAwaitReply(port, '22' + FS + '123' + FS + FS + '9');
    assert.strictEqual(first, 'HELLO-FROM-CONSOLE');

    const second = await sendAndAwaitReply(port, '22' + FS + '123' + FS + FS + '9');
    assert.strictEqual(second, '1' + FS + FS + FS + '1'); // 覆盖用掉了，落回规则引擎
  } finally {
    await new Promise((resolve) => app.server.close(resolve));
  }
});

test('config.messageLibrary 指向真实文件时，engine 能用 { key } 覆盖查到对应 payload', async () => {
  const capDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ndc-override-lib-'));
  const libDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ndc-lib-'));
  const libPath = path.join(libDir, 'lib.doc');

  // 内联构造一条最小的库文件：11 字节头 + 1 条 614 字节记录（key=GIS）。
  const HEADER = 'M1187RESV\r\n';
  const payload = '1' + FS + FS + FS + '1';
  const lengthField = String(payload.length).padStart(4, '0');
  const keyField = 'GIS'.padEnd(8, ' ');
  const record = (lengthField + keyField + payload).padEnd(614, ' ');
  fs.writeFileSync(libPath, HEADER + record, 'latin1');

  const app = createApp({
    enableTLS: false,
    captureDir: capDir,
    rules: [],
    messageLibrary: libPath,
  });
  app.engine.setNextResponse({ key: 'GIS' });

  await new Promise((resolve) => app.server.listen(0, resolve));
  const port = app.server.address().port;
  try {
    const reply = await sendAndAwaitReply(port, '22' + FS + '123');
    assert.strictEqual(reply, payload);
  } finally {
    await new Promise((resolve) => app.server.close(resolve));
  }
});

test('config.messageLibrary 指向不存在的文件时不抛错，降级为空库，NDC 服务照常工作', async () => {
  const capDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ndc-override-missinglib-'));
  let app;
  assert.doesNotThrow(() => {
    app = createApp({
      enableTLS: false,
      captureDir: capDir,
      rules: [{ name: 'ready9-go-in-service', match: { messageClass: '2', field: { index: 3, startsWith: '9' } }, handler: 'goInService' }],
      messageLibrary: path.join(os.tmpdir(), 'this-file-does-not-exist-ndc-lib.doc'),
    });
  });

  await new Promise((resolve) => app.server.listen(0, resolve));
  const port = app.server.address().port;
  try {
    const reply = await sendAndAwaitReply(port, '22' + FS + '123' + FS + FS + '9');
    assert.strictEqual(reply, '1' + FS + FS + FS + '1'); // 规则引擎完全不受影响

    // 库是空的，{ key } 覆盖必须查不到，在 setNextResponse 这一刻就抛错。
    assert.throws(() => app.engine.setNextResponse({ key: 'GIS' }), /unknown library key/);
  } finally {
    await new Promise((resolve) => app.server.close(resolve));
  }
});
