const test = require('node:test');
const assert = require('node:assert');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');
const { createApp } = require('../server');
const { FS } = require('../src/constants');
const { encodeLength, createDecoder } = require('../src/framing');

/**
 * 「先确认手续费/汇率再记账」的端到端。
 *
 * 主机侧的三态在这里全部走一遍：第一条请求 → Interactive Transaction Response；
 * 带接受字母的重发 → 真正的交易应答；带拒绝字母的重发 → 拒绝应答。
 */

const RULES = [
  { name: 'host-confirmation', match: { messageClass: '1', subClass: '1' }, handler: 'hostConfirmation' },
  {
    name: 'withdrawal-approved',
    match: { messageClass: '1', subClass: '1' },
    handler: 'withdrawal',
  },
];

const WITHDRAWAL = {
  cassettes: [50, 100, 500, 1000],
  approvedNextState: '123',
  receipt: { printerData: 'USD <AMOUNT>' },
};

/** 一条取款 Transaction Request；`bufferB` 落在段 10。 */
function request(bufferB = '') {
  const fields = ['11', '000', '', '', '15', ';XXXX=XXXX?', '', 'A A  A A', '00010000', '', bufferB, ''];
  return fields.join(FS);
}

/** 起一个模拟器，返回一个「发一条、收一条」的客户端。 */
async function withSimulator(config, run) {
  const capDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ndc-hc-'));
  const app = createApp({ enableTLS: false, responseDelayMs: 0, captureDir: capDir, ...config });
  await new Promise((resolve) => app.server.listen(0, resolve));
  const port = app.server.address().port;

  const dec = createDecoder();
  const pending = [];
  const waiters = [];
  const client = net.createConnection({ port });
  client.on('data', (d) => {
    for (const frame of dec.push(d)) {
      const text = frame.toString('latin1');
      const waiter = waiters.shift();
      if (waiter) waiter(text); else pending.push(text);
    }
  });
  await new Promise((resolve) => client.once('connect', resolve));

  const exchange = (payload) => new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('simulator did not answer')), 3000);
    const settle = (text) => { clearTimeout(timer); resolve(text.split(FS)); };
    if (pending.length) settle(pending.shift());
    else waiters.push(settle);
    client.write(encodeLength(Buffer.from(payload, 'latin1')));
  });

  try {
    await run(exchange);
  } finally {
    client.end();
    await new Promise((resolve) => app.server.close(resolve));
  }
}

test('关闭时（出厂默认）行为不变：取款直接拿到交易应答', { timeout: 5000 }, async () => {
  await withSimulator(
    { rules: RULES, withdrawal: WITHDRAWAL, hostConfirmation: { enabled: false } },
    async (exchange) => {
      const reply = await exchange(request());
      assert.strictEqual(reply[0], '4');
      assert.strictEqual(reply[3], '123');
    },
  );
});

test('手续费：先回交互式应答，接受后才给交易应答', { timeout: 5000 }, async () => {
  await withSimulator(
    { rules: RULES, withdrawal: WITHDRAWAL, hostConfirmation: { enabled: true, scenario: 'surcharge' } },
    async (exchange) => {
      const ir = await exchange(request());
      assert.strictEqual(ir[0], '3', '第一条应答是 Interactive Transaction Response');
      assert.strictEqual(ir[3], '21AB', '子类 2 + 显示标志 1 + active keys AB');
      assert.strictEqual(ir[4].length, 3, '屏幕计时器恰好 3 位');
      assert.match(ir[5], /SURCHARGE/);
      assert.match(ir[5], /Fee=\$2\.00/);

      // ATM 把持卡人按的键放进 Buffer B 重发同一笔。
      const reply = await exchange(request('A'));
      assert.strictEqual(reply[0], '4', '接受之后才是真正的交易应答');
      assert.strictEqual(reply[3], '123');
    },
  );
});

test('手续费被拒：主机回拒绝的交易应答，不出钞', { timeout: 5000 }, async () => {
  await withSimulator(
    {
      rules: RULES,
      withdrawal: WITHDRAWAL,
      hostConfirmation: { enabled: true, scenario: 'surcharge', declineNextState: '048' },
    },
    async (exchange) => {
      await exchange(request());
      const reply = await exchange(request('B'));
      assert.strictEqual(reply[0], '4');
      assert.strictEqual(reply[3], '048', '拒绝用的是配置里的 declineNextState');
      assert.strictEqual(reply[4], '', 'fieldG 为空 = 不出钞');
    },
  );
});

test('DCC：三个选项，选本币（F）之后照常授权', { timeout: 5000 }, async () => {
  await withSimulator(
    { rules: RULES, withdrawal: WITHDRAWAL, hostConfirmation: { enabled: true, scenario: 'dcc' } },
    async (exchange) => {
      const ir = await exchange(request());
      assert.strictEqual(ir[3], '21DEF', 'active keys 是三个：外币 D / 拒绝 E / 本币 F');
      assert.match(ir[5], /CONDITIONAL=1800/);
      assert.match(ir[5], /EXCHANGETYPE=DCC/);
      assert.match(ir[5], /TOTALL=ZAR 1850\.00/);
      assert.match(ir[5], /TOTALF=USD 100\.00/);

      const reply = await exchange(request('F'));
      assert.strictEqual(reply[0], '4');
      assert.strictEqual(reply[3], '123');
    },
  );
});

test('转账那种 Buffer B 本来就有内容的请求，照样先问一次', { timeout: 5000 }, async () => {
  // 判据是「Buffer B 是不是本场景的应答字母」，不是「Buffer B 是不是空的」——
  // 后者会让转账（Buffer B 放目标账号）永远问不出确认屏。
  await withSimulator(
    { rules: RULES, withdrawal: WITHDRAWAL, hostConfirmation: { enabled: true, scenario: 'surcharge' } },
    async (exchange) => {
      const ir = await exchange(request('1234567890123'));
      assert.strictEqual(ir[0], '3');
    },
  );
});

test('每笔只问一次：字母对不上时不再追问，避免与 ATM 的轮数上限对撞', { timeout: 5000 }, async () => {
  await withSimulator(
    { rules: RULES, withdrawal: WITHDRAWAL, hostConfirmation: { enabled: true, scenario: 'surcharge' } },
    async (exchange) => {
      assert.strictEqual((await exchange(request()))[0], '3');
      // ATM 回了一个本场景里没有的字母（字母表对不上）。主机不再问，落到正常授权。
      const second = await exchange(request('X'));
      assert.strictEqual(second[0], '4');
    },
  );
});

test('未知场景名在装配阶段就抛错，不拖到 ATM 真发报文', { timeout: 5000 }, () => {
  assert.throws(
    () => createApp({
      enableTLS: false,
      rules: RULES,
      hostConfirmation: { enabled: true, scenario: 'no-such-scenario' },
    }),
    /unknown scenario "no-such-scenario"/,
  );
});
