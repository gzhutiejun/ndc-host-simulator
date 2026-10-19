const test = require('node:test');
const assert = require('node:assert');
const net = require('node:net');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createApp } = require('../server');
const { FS } = require('../src/constants');
const { encodeLength, createDecoder } = require('../src/framing');
const { parseLibrary } = require('../src/message-library');

// config-ndc-vm.json（ITM VM 上 acc-ndc-app 连的那份）的完整规则表 + 真实报文库跑端到端。
// 钉两件事：acc-ndc-app 的支票存款请求（操作码 BA A A A）拿到报文库里那条支票存款受理应答
// （NS 001、FID 1 存款并打印）；余额查询及 CUBC 的 BA 族请求的应答跟加规则之前逐字节一致。
const root = path.join(__dirname, '..');
const cfg = JSON.parse(fs.readFileSync(path.join(root, 'config-ndc-vm.json'), 'utf8'));
const libraryPath = path.join(root, cfg.messageLibrary);
const library = parseLibrary(fs.readFileSync(libraryPath));
const libraryPayload = (key) => library.find((e) => e.key === key).payload;

// 两条真实请求的字段（acc-ndc-app 在 VM 上发出，2026-10-19）：
// - 支票存款：app 日志 20261019_07.tcj 07:25:03 `TX txnRequest 11|000|||11|<track2>||BA A A A|00005000|<PIN>||`；
// - 余额查询：app 日志 20261019_05.tcj 05:41:37 `TX txnRequest 11|000|||12|<track2>||C A  A A||<PIN>||`。
// app 日志把 track 2 与 PIN 缓冲遮成 X（长度 34 / 16）；这里填的是同一张 VM 测试卡在主机模拟器
// sim-vm.log（2026-10-19 14:27:59Z，BB A A A）里原样记下的 track 2 与 PIN 缓冲——同卡同 PIN 的
// PIN 缓冲是确定的（同一日志里三笔交易逐字节相同）。
const TRACK2 = '4221311111111114=30121010000000000';
const PIN = '<54>46;??546>?42';
const CHEQUE_REQUEST = ['11', '000', '', '', '11', TRACK2, '', 'BA A A A', '00005000', PIN, '', ''];
const BALANCE_REQUEST = ['11', '000', '', '', '12', TRACK2, '', 'C A  A A', '', PIN, '', ''];

async function withApp(fn) {
  const captureDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ndc-vm-cheque-'));
  const app = createApp({ ...cfg, uiPort: undefined, responseDelayMs: 0, messageLibrary: libraryPath, captureDir });
  await new Promise((resolve) => app.server.listen(0, resolve));
  const dec = createDecoder();
  const replies = [];
  const client = await new Promise((resolve, reject) => {
    const c = net.createConnection({ port: app.server.address().port }, () => resolve(c));
    c.on('error', reject);
  });
  client.on('data', (d) => { for (const f of dec.push(d)) replies.push(f.toString('latin1')); });
  const send = async (fields) => {
    const n = replies.length;
    client.write(encodeLength(Buffer.from(fields.join(FS), 'latin1')));
    await new Promise((resolve) => { const t = setInterval(() => { if (replies.length > n) { clearInterval(t); resolve(); } }, 10); });
    return replies[n];
  };
  try { await fn(send); } finally {
    client.end();
    await new Promise((resolve) => app.server.close(resolve));
  }
}

test('acc-ndc-app 支票存款 BA A A A：报文库的支票存款受理应答（NS 001、FID 1），不再被 ddc-balance-stage1 吃掉（055）', { timeout: 5000 }, async () => {
  await withApp(async (send) => {
    const reply = await send(CHEQUE_REQUEST);
    assert.strictEqual(reply, libraryPayload('BA A A A'));
    const f = reply.split(FS);
    assert.strictEqual(f[3], '001');
    assert.strictEqual(f[5][4], '1'); // 扇区 6 = TSN(4) + FID(1)：'1' 存款并打印
    assert.ok(reply.includes('CHECK DEPOSIT'));
  });
});

test('acc-ndc-app 支票存款其余形状（存入储蓄 BA B、不要凭条 B）：走同一条规则，不落进 ddc-balance-stage2（BA B）', { timeout: 5000 }, async () => {
  await withApp(async (send) => {
    for (const opcode of ['BA B A A', 'BA A B A', 'BA B B A']) {
      const fields = CHEQUE_REQUEST.slice();
      fields[7] = opcode;
      assert.strictEqual(await send(fields), libraryPayload(opcode), opcode);
    }
  });
});

test('acc-ndc-app 余额查询 C A  A A：应答不变（报文库 C A  A A，NS 001）', { timeout: 5000 }, async () => {
  await withApp(async (send) => {
    const reply = await send(BALANCE_REQUEST);
    assert.strictEqual(reply, libraryPayload('C A  A A'));
    assert.strictEqual(reply.split(FS)[3], '001');
  });
});

test('CUBC 形状的 BA 族请求不被支票规则命中：BA AA C → 055、BA BA C → 063、BAFC → 071', { timeout: 5000 }, async () => {
  await withApp(async (send) => {
    const ns = async (opcode) => {
      const fields = CHEQUE_REQUEST.slice();
      fields[7] = opcode;
      fields[8] = '000000000000';
      return (await send(fields)).split(FS)[3];
    };
    assert.strictEqual(await ns('BA AA C '), '055');
    assert.strictEqual(await ns('BA BA C '), '063');
    assert.strictEqual(await ns('BAFCA C '), '071');
  });
});
