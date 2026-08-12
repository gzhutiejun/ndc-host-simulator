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
const { FS } = require('../src/constants');

const cfg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'config.json'), 'utf8'));

// 出厂规则里第一条 host-confirmation 匹配所有 class 1/1，所以任何用 config.json 的
// 规则集建 engine 的测试都必须提供这个 handler。按出厂配置（enabled:false）建出来的
// 那个恒返回 null，于是引擎照常落到后面的 libraryKey 规则——下面几个断言测的正是那条路径。
const handlers = { hostConfirmation: makeHostConfirmation(cfg.hostConfirmation || {}) };

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
