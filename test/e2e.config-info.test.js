const test = require('node:test');
const assert = require('node:assert');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');
const { createApp } = require('../server');
const { FS } = require('../src/constants');
const { encodeLength, createDecoder } = require('../src/framing');

// 本仓 e2e 的既有约定：内联自己的 RULES，不读 config.json。
// 它们验证引擎接线，不验证出厂配置 —— 出厂配置由 config.test.js 的静态断言守。
const RULES = [
  { name: 'solicited-no-reply', match: { messageClass: '2' }, noReply: true },
  { name: 'unsolicited-no-reply', match: { messageClass: '1', subClass: '2' }, noReply: true },
];

function startApp(pushOnConnect) {
  const capDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ndc-cfginfo-'));
  const app = createApp({ enableTLS: false, captureDir: capDir, rules: RULES, pushOnConnect });
  return { app, capDir };
}

/** 假 ATM：收到主机下发的帧后回一条固定应答，返回主机下发的那一帧。 */
function fakeAtm(port, reply, timeoutMs = 2000) {
  return new Promise((resolve, reject) => {
    const decoder = createDecoder();
    const client = net.createConnection({ port });
    const timer = setTimeout(() => {
      client.destroy();
      reject(new Error(`host pushed nothing within ${timeoutMs}ms`));
    }, timeoutMs);
    client.on('data', (d) => {
      const frames = decoder.push(d);
      if (!frames.length) return;
      clearTimeout(timer);
      const pushed = frames[0].toString('latin1');
      client.write(encodeLength(Buffer.from(reply, 'latin1')));
      setTimeout(() => { client.end(); resolve(pushed); }, 50);
    });
    client.on('error', (err) => { clearTimeout(timer); reject(err); });
  });
}

test('主机按 pushOnConnect 下发命令码 7 + 修饰符 3', async () => {
  const { app, capDir } = startApp([{ code: '7', modifier: '3', luno: '000' }]);
  await new Promise((r) => app.server.listen(0, r));
  try {
    const pushed = await fakeAtm(
      app.server.address().port,
      '22' + FS + '000' + FS + FS + 'F' + FS + 'JAE2',
    );
    assert.strictEqual(pushed, '1' + FS + '000' + FS + FS + '73');
  } finally {
    await new Promise((r) => app.server.close(r));
  }

  // capture 日志是真机排障时唯一的证据来源 —— 断言它确实落了盘，
  // 而不是只建了个空目录(原计划写了这条却没实现)。
  const files = fs.readdirSync(capDir).filter((f) => f.startsWith('session-'));
  assert.ok(files.length > 0, 'capture 日志未落盘');
  const log = fs.readFileSync(path.join(capDir, files[0]), 'utf8');
  assert.match(log, /SEND .*TerminalCommand/, 'capture 里没有下发的终端命令');
  assert.match(log, /RECV/, 'capture 里没有收到的 ATM 应答');
});

test('修饰符 2 同样下发得出去', async () => {
  const { app } = startApp([{ code: '7', modifier: '2', luno: '000' }]);
  await new Promise((r) => app.server.listen(0, r));
  try {
    const pushed = await fakeAtm(
      app.server.address().port,
      '22' + FS + '000' + FS + FS + 'F' + FS + 'IAE13',
    );
    assert.strictEqual(pushed, '1' + FS + '000' + FS + FS + '72');
  } finally {
    await new Promise((r) => app.server.close(r));
  }
});

test('ATM 的 solicited 应答被主机收下且不再回包（避免与 ATM 打成循环）', async () => {
  const capDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ndc-cfginfo-'));
  const app = createApp({
    enableTLS: false, captureDir: capDir, rules: RULES,
    pushOnConnect: [{ code: '7', modifier: '3', luno: '000' }],
  });
  await new Promise((r) => app.server.listen(0, r));
  try {
    const port = app.server.address().port;
    const secondPush = await new Promise((resolve, reject) => {
      const decoder = createDecoder();
      const client = net.createConnection({ port });
      let count = 0;
      const timer = setTimeout(() => { client.destroy(); resolve(count); }, 600);
      client.on('data', (d) => {
        for (const f of decoder.push(d)) {
          count += 1;
          if (count === 1) {
            // 回一条 solicited 应答；主机不应因此再下发第二条
            client.write(encodeLength(Buffer.from('22' + FS + '000' + FS + FS + 'F' + FS + 'JAE2', 'latin1')));
          }
        }
      });
      client.on('error', (err) => { clearTimeout(timer); reject(err); });
    });
    assert.strictEqual(secondPush, 1, '主机只应下发一次');
  } finally {
    await new Promise((r) => app.server.close(r));
  }
});

test('unsolicited 设备状态报文主机不应答', async () => {
  const { app } = startApp([]);
  await new Promise((r) => app.server.listen(0, r));
  try {
    const port = app.server.address().port;
    const gotReply = await new Promise((resolve, reject) => {
      const client = net.createConnection({ port }, () => {
        // 模拟 ATM 发一条设备状态 unsolicited：class 1 / sub 2，DIG 'E' + device status '0'
        client.write(encodeLength(Buffer.from('12' + FS + '000' + FS + FS + 'E0' + FS + '4' + FS + '19', 'latin1')));
      });
      client.on('data', () => { resolve(true); client.end(); });
      client.on('error', reject);
      setTimeout(() => { resolve(false); client.end(); }, 400);
    });
    assert.strictEqual(gotReply, false);
  } finally {
    await new Promise((r) => app.server.close(r));
  }
});
