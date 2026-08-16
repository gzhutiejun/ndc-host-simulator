const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { createEngine } = require('../src/engine');
const { parseLibrary } = require('../src/message-library');
const { parse } = require('../src/ndc/parser');
const { encodeText } = require('../src/framing');
const { createSession } = require('../src/session');
const makeHostConfirmation = require('../src/handlers/hostConfirmation');
const makeGeneric = require('../src/handlers/generic');
const { FS } = require('../src/constants');

const cfg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'config.json'), 'utf8'));

// 出厂规则里第一条 host-confirmation 匹配所有 class 1/1，所以任何用 config.json 的
// 规则集建 engine 的测试都必须提供这个 handler。按出厂配置（enabled:false）建出来的
// 那个恒返回 null，于是引擎照常落到后面的 libraryKey 规则——下面几个断言测的正是那条路径。
// generic 是 generic-fallback 那条兜底规则要用的——只有走到兜底的用例（库里没有的操作码）
// 才会真的调用它；前面那些能在库里查到应答的用例在此之前就返回了，注册它不改变它们的结果。
const handlers = {
  hostConfirmation: makeHostConfirmation(cfg.hostConfirmation || {}),
  generic: makeGeneric(cfg.generic || {}),
  // familyD/familyI 在 server.js 里就是同一个 makeGeneric 的两个实例，这里照搬，
  // 好让"DG 规则不该吃掉整个 D 族"这类护栏用例走得到真正的 D 族路径。
  familyD: makeGeneric(cfg.familyD || {}),
  familyI: makeGeneric(cfg.familyI || {}),
};

test('config.json: familyD/familyI blocks carry the observed next-states (698/175)', () => {
  assert.strictEqual(cfg.familyD.nextState, '698');
  assert.strictEqual(cfg.familyI.nextState, '175');
});

test('config.json: d/i family rules precede the generic-fallback catch-all and route correctly', () => {
  const names = cfg.rules.map((r) => r.name);
  const d = names.indexOf('d-family-reply');
  const i = names.indexOf('i-family-reply');
  const g = names.indexOf('generic-fallback');
  assert.ok(d !== -1 && i !== -1, 'both family rules present');
  assert.ok(g !== -1, 'generic-fallback present');
  assert.ok(d < g && i < g, 'family rules must come before generic-fallback');
  assert.strictEqual(cfg.rules[d].match.field.startsWith, 'D');
  assert.strictEqual(cfg.rules[d].handler, 'familyD');
  assert.strictEqual(cfg.rules[i].match.field.startsWith, 'I');
  assert.strictEqual(cfg.rules[i].handler, 'familyI');
});

test('规则集：上电报文触发 go-in-service，且排在 unsolicited 兜底之前', () => {
  const cfg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'config.json'), 'utf8'));
  const names = cfg.rules.map((r) => r.name);
  assert.ok(names.includes('powerup-go-in-service'), '缺 powerup-go-in-service 规则');
  assert.ok(
    names.indexOf('powerup-go-in-service') < names.indexOf('unsolicited-status-no-reply'),
    'powerup 规则必须排在 unsolicited 兜底之前，否则永远匹配不到',
  );
});

test('规则集：Ready 9 不再触发 go-in-service（会与 ATM 打成无限循环）', () => {
  const cfg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'config.json'), 'utf8'));
  const ready9 = cfg.rules.filter(
    (r) => r.match && r.match.messageClass === '2'
      && r.match.field && r.match.field.startsWith === '9',
  );
  assert.strictEqual(ready9.length, 1, '应恰好有一条匹配 Ready 9 的规则');
  assert.strictEqual(ready9[0].handler, undefined, 'Ready 9 不应挂 handler');
  assert.strictEqual(ready9[0].noReply, true, 'Ready 9 应为 noReply');
});

// ---- 报文库驱动的出厂规则（取代硬编码 handler 默认路径） ----

test('config.json: withdrawal-request/balance-inquiry 规则现在指向报文库的 key，不再挂 handler', () => {
  const withdrawal = cfg.rules.find((r) => r.name === 'withdrawal-request');
  const balance = cfg.rules.find((r) => r.name === 'balance-inquiry');
  assert.ok(withdrawal, 'withdrawal-request 规则应存在');
  assert.ok(balance, 'balance-inquiry 规则应存在');
  assert.strictEqual(withdrawal.libraryKey, 'A A  A A');
  assert.strictEqual(withdrawal.handler, undefined, 'withdrawal-request 不应再挂 handler，避免两条路径打架');
  assert.strictEqual(balance.libraryKey, 'C A  A A');
  assert.strictEqual(balance.handler, undefined, 'balance-inquiry 不应再挂 handler，避免两条路径打架');
});

test('config.json: 三个凭条模板不再说 AED（这个部署点的币种是 USD）', () => {
  const text = fs.readFileSync(path.join(__dirname, '..', 'config.json'), 'utf8');
  assert.doesNotMatch(text, /AED/, 'config.json 里不应再出现 AED');
  assert.match(cfg.withdrawal.receipt.printerData, /USD/);
  assert.match(cfg.withdrawal.declineReceipt.printerData, /USD/);
  assert.match(cfg.balance.receipt.printerData, /USD/);
});

test('config.json + 随仓库分发的报文库：启动期能装配出一个可用的 engine（libraryKey 全部能查到），不会像改动前那样直接崩', () => {
  const libraryPath = path.join(__dirname, '..', cfg.messageLibrary);
  const library = parseLibrary(fs.readFileSync(libraryPath));
  assert.doesNotThrow(() => createEngine({ rules: cfg.rules, handlers, library }));
});

test('config.json + 报文库：取款规则应出一个 ATM 认得的下一状态（001），并带上真实出钞字段——不再是发明的 123', () => {
  const libraryPath = path.join(__dirname, '..', cfg.messageLibrary);
  const library = parseLibrary(fs.readFileSync(libraryPath));
  const engine = createEngine({ rules: cfg.rules, handlers, library });
  const req = ['11', '000', '', '', '15', ';XXXX=XXXX?', '', 'ADC     ', '00000300'].join(FS);
  const out = engine.respond(parse(encodeText(req)), createSession());
  const f = out.payload.split(FS);
  assert.strictEqual(out.rule, 'withdrawal-request');
  assert.strictEqual(f[3], '001', '库里的取款应答下一状态是 001（成功），不是硬编码路径发明的 123');
  assert.strictEqual(f[4], '01000000', '库里的取款应答带真实出钞字段');
});

// ---- H 族（迷你对账单 / ministatement）路由 ----
//
// 操作码来自 APTRA Activate 的请求构造配置
// （spl-ActivateEnterpriseProduct 的 ChnApp/Cnsmr/CnsmrAppAE/Source/Config/Customiser/
// RequestConfigurationTool.xml，<OpcodeConfiguration><OpcodeRecords>）：
//   TRANSLET_ID=MINISTATEMENT + VARIANT=MINISTATEMENT1..10 → 位 1-2 = "HA".."HJ"
//   （同一份配置里 FULLSTATEMENT1..8 → "LA".."LH"）
// 位 3 是账户（A=CHECKING、B=SAVINGS）——这一位的语义是从库键与应答凭条正文反推的，
// 与 src/message-library.js 头部注释同口径，不是权威文档。
//
// 这几条钉的是**路由**：H 族靠 opcode-library 规则直接查库作答，而不是掉进 generic-fallback
// 拿一个 048「交易取消」。断言选的是应答凭条里的字面文案（MINISTATEMENT1 / MINISTATEMENT10 /
// SAVINGS），因为那是库自己写的、能独立佐证"这条应答确实是迷你对账单"的东西。
//
// 注：区域配置会覆盖操作码——Everlink（加拿大）把 MINISTATEMENT 整个改成 "DG      "，
// 而随仓库分发的这个库里 DG* 命中 0 条。要测那条路径得另行补库或补规则，这里不涉及。

function respondToOpcode(opcode) {
  const libraryPath = path.join(__dirname, '..', cfg.messageLibrary);
  const library = parseLibrary(fs.readFileSync(libraryPath));
  const engine = createEngine({ rules: cfg.rules, handlers, library });
  const req = ['11', '000', '', '', '15', ';XXXX=XXXX?', '', opcode, ''].join(FS);
  return engine.respond(parse(encodeText(req)), createSession());
}

test('config.json: opcode-library 规则排在 generic-fallback 之前，否则 H 族会被兜底吃掉', () => {
  const names = cfg.rules.map((r) => r.name);
  const opcodeRule = names.indexOf('opcode-library');
  assert.notStrictEqual(opcodeRule, -1, '缺 opcode-library 规则，H 族就没有任何路径能答上来');
  assert.strictEqual(cfg.rules[opcodeRule].libraryKeyFromField.index, 7, '操作码取报文第 7 段');
  assert.ok(
    opcodeRule < names.indexOf('generic-fallback'),
    'opcode-library 必须排在 generic-fallback 之前',
  );
});

test('随仓库分发的报文库：H 族十个变体 × 两个账户全都在（HA..HJ × A/B）', () => {
  const libraryPath = path.join(__dirname, '..', cfg.messageLibrary);
  const keys = new Set(parseLibrary(fs.readFileSync(libraryPath)).map((r) => r.key));
  for (const variant of 'ABCDEFGHIJ') {
    for (const account of 'AB') {
      const key = `H${variant}${account}  A A`;
      assert.ok(keys.has(key), `报文库里缺 ${JSON.stringify(key)}`);
    }
  }
});

test('config.json + 报文库：迷你对账单 HAA 走库作答（下一状态 001、不出钞、凭条写 MINISTATEMENT1）', () => {
  const out = respondToOpcode('HAA  A A');
  assert.strictEqual(out.rule, 'opcode-library:HAA  A A', 'H 族应由 opcode-library 直接查库作答');
  const f = out.payload.split(FS);
  assert.strictEqual(f[3], '001', '迷你对账单的下一状态是 001，不是 generic 兜底的 048');
  assert.strictEqual(f[4], '00000000', '迷你对账单不出钞');
  assert.match(out.payload, /MINISTATEMENT1/);
  assert.match(out.payload, /CHECKING/);
});

test('config.json + 报文库：操作码位 2 选变体——HJA 出的是 MINISTATEMENT10，不是 MINISTATEMENT1', () => {
  const out = respondToOpcode('HJA  A A');
  assert.strictEqual(out.rule, 'opcode-library:HJA  A A');
  assert.match(out.payload, /MINISTATEMENT10/);
});

test('config.json + 报文库：操作码位 3 选账户——HAB 出的是 SAVINGS，不是 CHECKING', () => {
  const out = respondToOpcode('HAB  A A');
  assert.strictEqual(out.rule, 'opcode-library:HAB  A A');
  assert.match(out.payload, /MINISTATEMENT1/);
  assert.match(out.payload, /SAVINGS/);
  assert.doesNotMatch(out.payload, /CHECKING/);
});

// ---- H 族兜底 + Everlink 的 DG ----
//
// 报文库里那 23 条 H* 键的位 5-8 全是 "  A A" 这一种，位 3 只有 A/B、位 4 只有空格/C。
// 真机只要在别的位上发了不同字符（历史上还出现过只发位 1 的截断操作码），精确查库就会
// 落空、掉进 generic 兜底拿一个 048「交易取消」——测迷你对账单时这看着就像"主机不支持"。
// 所以补一条 H 族兜底：任何 H 开头的都回迷你对账单应答。代价是丢掉变体/账户的区分，
// 所以它必须排在 opcode-library **之后**——能精确命中的仍然走精确的那条。
//
// DG 是 Everlink（加拿大）区域把 MINISTATEMENT 覆盖成的操作码，库里 0 命中；不特殊处理
// 的话它会被 d-family-reply 按 "D 开头" 吃掉，回一个 698（D 族/改密）。

test('config.json + 报文库：库里没有的 H 变体不再落 048，由 H 族兜底回迷你对账单', () => {
  for (const opcode of ['HZA  A A', 'HAA  B A', 'HAA  A B', 'HA      ', 'H       ']) {
    const out = respondToOpcode(opcode);
    assert.strictEqual(out.rule, 'h-family-ministatement', `${JSON.stringify(opcode)} 应走 H 族兜底`);
    assert.strictEqual(out.payload.split(FS)[3], '001', `${JSON.stringify(opcode)} 应回 001 而不是 048`);
    assert.match(out.payload, /MINISTATEMENT/);
  }
});

test('config.json + 报文库：H 族兜底不抢精确命中——HAA/HJA/HAB 仍走 opcode-library', () => {
  assert.strictEqual(respondToOpcode('HAA  A A').rule, 'opcode-library:HAA  A A');
  assert.strictEqual(respondToOpcode('HJA  A A').rule, 'opcode-library:HJA  A A');
  assert.match(respondToOpcode('HJA  A A').payload, /MINISTATEMENT10/, '变体区分不能被兜底吃掉');
  assert.match(respondToOpcode('HAB  A A').payload, /SAVINGS/, '账户区分不能被兜底吃掉');
});

test('config.json + 报文库：Everlink 的 DG 回迷你对账单，不再被 D 族当成改密回 698', () => {
  const out = respondToOpcode('DG      ');
  assert.strictEqual(out.rule, 'everlink-ministatement');
  assert.strictEqual(out.payload.split(FS)[3], '001');
  assert.match(out.payload, /MINISTATEMENT/);
});

test('config.json：DG 规则只吃 DG，其余 D 族仍然走 familyD 的 698', () => {
  const out = respondToOpcode('DAA  A A');
  assert.strictEqual(out.rule, 'd-family-reply');
  assert.strictEqual(out.payload.split(FS)[3], '698');
});

test('config.json：两条新规则的位置——DG 在 d-family 之前，H 族兜底在 opcode-library 之后、generic 之前', () => {
  const names = cfg.rules.map((r) => r.name);
  const ev = names.indexOf('everlink-ministatement');
  const h = names.indexOf('h-family-ministatement');
  const opcode = names.indexOf('opcode-library');
  assert.ok(ev !== -1 && h !== -1, '两条新规则都应存在');
  assert.ok(ev < names.indexOf('d-family-reply'), 'DG 规则必须排在 d-family-reply 之前，否则被 D 族吃掉');
  assert.ok(opcode < h, 'H 族兜底必须排在 opcode-library 之后，否则精确命中会被它抢走');
  assert.ok(h < names.indexOf('generic-fallback'), 'H 族兜底必须排在 generic-fallback 之前');
});

test('config.json + 报文库：余额查询规则应出下一状态 001、不出钞，屏幕字段带三个余额', () => {
  const libraryPath = path.join(__dirname, '..', cfg.messageLibrary);
  const library = parseLibrary(fs.readFileSync(libraryPath));
  const engine = createEngine({ rules: cfg.rules, handlers, library });
  const req = ['11', '000', '', '', '15', ';XXXX=XXXX?', '', 'CC   C  ', ''].join(FS);
  const out = engine.respond(parse(encodeText(req)), createSession());
  const f = out.payload.split(FS);
  assert.strictEqual(out.rule, 'balance-inquiry');
  assert.strictEqual(f[3], '001', '库里的余额应答下一状态是 001（成功），不是硬编码路径发明的 074');
  assert.strictEqual(f[4], '00000000', '余额查询不出钞');
  assert.match(f[5], /AvailableBal=\$1111\.11;CurrentBal=\$2222\.22;AccountBal=\$3333\.33/);
});
