# Withdrawal Transaction Flow (子项目 2a) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 simulator 收到 ATM 的取款 TransactionRequest(类 `1`/子 `1`) 时，返回一条有效的
TransactionReply(类 `4`)，驱动真实 ATM 完成取款（下一状态 123 + 出钞 fieldG + 退卡 + 最小凭条）。

**Architecture:** 复用子项目 1 全部模块（transport/framing/parser/session/engine/logging 不改，
engine 仅新增 `now` 注入）。新增纯函数 `dispense`（金额→fieldG 贪心分解）、`transactionReply`
构造器（字段级 FS 序列化）、`transactionRequest` 抽取器（取金额/MCN），以及 `withdrawal`
handler 工厂把它们组合起来。取款识别写进引擎规则的 `match`（field[7]=='ADC     '），故余额等
其它 TxnRequest 不命中本规则、自然走 UNMATCHED。

**Tech Stack:** Node.js（>=18），零第三方依赖，`node:test` + `node:assert`。

## Global Constraints

- **零第三方依赖**：只允许 Node 内置模块。`package.json` 不得新增 dependencies/devDependencies。
- **报文帧**：`[2字节大端长度][payload]`；文本用 latin1（沿用子项目 1 的 framing）。
- **TransactionReply 字段顺序**（FS=0x1C 分隔）：`'4' | LUNO | STN | nextState | fieldG | screen | printer | [CAM]`。无 ETX、无 MAC（本终端实测禁用）。
- **fieldG**：4 磁箱各 2 位十进制张数拼接，磁箱面额默认 `[50,100,500,1000]`（C1..C4）。
- **取款识别**：请求 field[7]==`'ADC     '`（`ADC`+5 空格，共 8 字符）；金额在 field[8]（8 位数字）；MCN=field[4] 的第 2 个字符。识别写进规则 `match`，不在 handler 内判。
- **默认批准**：nextState=`'123'`，returnCard=`'0'`；decline 仅留接口。
- **测试命令**：`node --test`（全部）；单文件 `node --test test/<name>.test.js`。
- 现有测试基线：main 上 29 个测试通过；每个任务只增不减。

## 文件结构

```
src/dispense.js                 金额 → fieldG 贪心分解（纯函数）      [Task 1]
src/ndc/transactionReply.js     buildTransactionReply(parts) → 报文串  [Task 2]
src/ndc/transactionRequest.js   extractWithdrawal(parsed, cfg)         [Task 3]
src/engine.js (modify)          createEngine 新增 now 注入进 helpers   [Task 4]
src/handlers/withdrawal.js      makeWithdrawal(cfg) → handler 工厂      [Task 5]
server.js / config.json (modify) 装配 withdrawal + 规则 + e2e + README  [Task 6]
test/*.test.js                  各任务单测
```

---

### Task 1: dispense —— 金额→fieldG 贪心分解

**Files:**
- Create: `src/dispense.js`
- Create: `test/dispense.test.js`

**Interfaces:**
- Consumes: 无
- Produces: `src/dispense.js` 导出
  - `breakdown(amount: number, cassettes?: number[]): { fieldG: string, ok: boolean, counts: number[] }`
    - `cassettes` 默认 `[50,100,500,1000]`（索引 0..3 = C1..C4）。
    - 贪心：面额从大到小凑够 `amount`；`ok = (remaining===0 && amount>0)`。
    - `counts` 按 cassettes 原始顺序（C1..C4）每箱张数；`fieldG` = 各 count `padStart(2,'0')` 拼接。

- [ ] **Step 1: 写失败测试**

Create `test/dispense.test.js`:

```js
const test = require('node:test');
const assert = require('node:assert');
const { breakdown } = require('../src/dispense');

test('breakdown 300 with default cassettes → 3x100', () => {
  const r = breakdown(300);
  assert.strictEqual(r.ok, true);
  assert.deepStrictEqual(r.counts, [0, 3, 0, 0]); // C1=50,C2=100,C3=500,C4=1000
  assert.strictEqual(r.fieldG, '00030000');
});

test('breakdown 50 → single 50 note', () => {
  const r = breakdown(50);
  assert.deepStrictEqual(r.counts, [1, 0, 0, 0]);
  assert.strictEqual(r.fieldG, '01000000');
});

test('breakdown 10000 → 10x1000', () => {
  const r = breakdown(10000);
  assert.deepStrictEqual(r.counts, [0, 0, 0, 10]);
  assert.strictEqual(r.fieldG, '00000010');
});

test('amount not dispensable → ok false', () => {
  const r = breakdown(30); // 30 not reachable with [50,100,500,1000]
  assert.strictEqual(r.ok, false);
});

test('zero amount → ok false', () => {
  assert.strictEqual(breakdown(0).ok, false);
});

test('custom cassettes respected', () => {
  const r = breakdown(300, [100, 200]);
  assert.strictEqual(r.ok, true);
  assert.deepStrictEqual(r.counts, [1, 1]); // greedy: 1x200 + 1x100
  assert.strictEqual(r.fieldG, '0101');
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `node --test test/dispense.test.js`
Expected: FAIL —— `Cannot find module '../src/dispense'`

- [ ] **Step 3: 实现 dispense.js**

Create `src/dispense.js`:

```js
function breakdown(amount, cassettes = [50, 100, 500, 1000]) {
  const counts = new Array(cassettes.length).fill(0);
  // 贪心：按面额从大到小分配
  const order = cassettes
    .map((denom, idx) => ({ denom, idx }))
    .sort((a, b) => b.denom - a.denom);
  let remaining = amount;
  for (const { denom, idx } of order) {
    if (denom <= 0) continue;
    const n = Math.floor(remaining / denom);
    counts[idx] = n;
    remaining -= n * denom;
  }
  const ok = remaining === 0 && amount > 0;
  const fieldG = counts.map((c) => String(c).padStart(2, '0')).join('');
  return { fieldG, ok, counts };
}

module.exports = { breakdown };
```

- [ ] **Step 4: 运行测试确认通过**

Run: `node --test test/dispense.test.js`
Expected: PASS（6 tests）

- [ ] **Step 5: 提交**

```bash
git add src/dispense.js test/dispense.test.js
git commit -m "feat: add cash-dispense denomination breakdown"
```

---

### Task 2: transactionReply —— 字段级构造器

**Files:**
- Create: `src/ndc/transactionReply.js`
- Create: `test/transactionReply.test.js`

**Interfaces:**
- Consumes: `src/constants.js`（FS）
- Produces: `src/ndc/transactionReply.js` 导出
  - `buildTransactionReply(parts): string`，`parts = { luno, stn?, nextState, fieldG, screen?, printer?, cam? }`
    - 序列化为 FS 连接：`['4', luno, stn, nextState, fieldG, screen, printer]`，若 `cam != null` 再追加 `cam`。
    - `stn` 默认 `''`；`screen`/`printer` 默认 `''`；`cam` 默认 `null`（不追加）。
    - 纯字符串拼接，不加 ETX/MAC/长度头（长度头由 server 的 framing 负责）。

- [ ] **Step 1: 写失败测试**

Create `test/transactionReply.test.js`:

```js
const test = require('node:test');
const assert = require('node:assert');
const { buildTransactionReply } = require('../src/ndc/transactionReply');
const { FS } = require('../src/constants');

test('builds a minimal transaction reply without CAM', () => {
  const out = buildTransactionReply({
    luno: '000', nextState: '123', fieldG: '00030000',
    screen: 'SCR', printer: '501RCPT',
  });
  assert.strictEqual(out, ['4', '000', '', '123', '00030000', 'SCR', '501RCPT'].join(FS));
});

test('appends CAM field when provided', () => {
  const out = buildTransactionReply({
    luno: '000', nextState: '123', fieldG: '00030000',
    screen: 'SCR', printer: '501RCPT', cam: '5CAM8A023030',
  });
  assert.strictEqual(
    out,
    ['4', '000', '', '123', '00030000', 'SCR', '501RCPT', '5CAM8A023030'].join(FS)
  );
});

test('honours explicit stn', () => {
  const out = buildTransactionReply({ luno: '000', stn: '7', nextState: '123', fieldG: '01000000' });
  assert.strictEqual(out, ['4', '000', '7', '123', '01000000', '', ''].join(FS));
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `node --test test/transactionReply.test.js`
Expected: FAIL —— `Cannot find module '../src/ndc/transactionReply'`

- [ ] **Step 3: 实现 transactionReply.js**

Create `src/ndc/transactionReply.js`:

```js
const { FS } = require('../constants');

function buildTransactionReply({
  luno,
  stn = '',
  nextState,
  fieldG,
  screen = '',
  printer = '',
  cam = null,
} = {}) {
  const fields = ['4', luno, stn, nextState, fieldG, screen, printer];
  if (cam != null) fields.push(cam);
  return fields.join(FS);
}

module.exports = { buildTransactionReply };
```

- [ ] **Step 4: 运行测试确认通过**

Run: `node --test test/transactionReply.test.js`
Expected: PASS（3 tests）

- [ ] **Step 5: 提交**

```bash
git add src/ndc/transactionReply.js test/transactionReply.test.js
git commit -m "feat: add transaction-reply field-level builder"
```

---

### Task 3: transactionRequest —— 取款字段抽取

**Files:**
- Create: `src/ndc/transactionRequest.js`
- Create: `test/transactionRequest.test.js`

**Interfaces:**
- Consumes: `src/ndc/parser.js`（`parse`）、`src/framing.js`（`encodeText`）、`src/constants.js`（FS）—— 仅测试用
- Produces: `src/ndc/transactionRequest.js` 导出
  - `extractWithdrawal(parsed, config?): { amount, luno, stn, mcn, panMasked }`
    - `config.amountFieldIndex` 默认 `8`。
    - `amount`：`parsed.fields[amountFieldIndex]` 若为纯数字则 `parseInt(_,10)`，否则 `null`。
    - `mcn`：`parsed.fields[4]` 的第 2 个字符（`field4[1]`，无则 `''`）。
    - `luno`：`parsed.luno`；`stn`：`parsed.fields[2] || ''`；`panMasked`：`parsed.fields[5] || ''`。

- [ ] **Step 1: 写失败测试（用真实抓包字段）**

Create `test/transactionRequest.test.js`:

```js
const test = require('node:test');
const assert = require('node:assert');
const { extractWithdrawal } = require('../src/ndc/transactionRequest');
const { parse } = require('../src/ndc/parser');
const { encodeText } = require('../src/framing');
const { FS } = require('../src/constants');

// 真实取款请求（截取 field[0..8]，PAN 掩码），来自 AJMN1301 抓包
function withdrawalReq() {
  const fields = ['11', '000', '', '', '15', ';XXXXXXXXXXXXXXXX=XXXXXXXXXXXXXXXXXXXX?', '', 'ADC     ', '00000300'];
  return parse(encodeText(fields.join(FS)));
}
// 真实余额请求（无金额，操作码 CC   C  ）
function balanceReq() {
  const fields = ['11', '000', '', '', '1=', ';XXXXXXXXXXXXXXXX=XXXXXXXXXXXX', '', 'CC   C  ', ''];
  return parse(encodeText(fields.join(FS)));
}

test('extracts amount, luno and MCN from a withdrawal request', () => {
  const r = extractWithdrawal(withdrawalReq());
  assert.strictEqual(r.amount, 300);
  assert.strictEqual(r.luno, '000');
  assert.strictEqual(r.mcn, '5'); // field[4]='15' → 第2字符 '5'
});

test('balance request has null amount (empty field[8])', () => {
  const r = extractWithdrawal(balanceReq());
  assert.strictEqual(r.amount, null);
});

test('respects a custom amountFieldIndex', () => {
  const p = parse(encodeText(['11', '000', '', '', '19', 'x', 'x', 'x', 'x', '00000750'].join(FS)));
  const r = extractWithdrawal(p, { amountFieldIndex: 9 });
  assert.strictEqual(r.amount, 750);
  assert.strictEqual(r.mcn, '9');
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `node --test test/transactionRequest.test.js`
Expected: FAIL —— `Cannot find module '../src/ndc/transactionRequest'`

- [ ] **Step 3: 实现 transactionRequest.js**

Create `src/ndc/transactionRequest.js`:

```js
function extractWithdrawal(parsed, config = {}) {
  const amountFieldIndex = config.amountFieldIndex != null ? config.amountFieldIndex : 8;
  const fields = parsed.fields || [];
  const amountRaw = fields[amountFieldIndex];
  const amount = amountRaw && /^\d+$/.test(amountRaw) ? parseInt(amountRaw, 10) : null;
  const field4 = fields[4] || '';
  const mcn = field4.length > 1 ? field4[1] : '';
  return {
    amount,
    luno: parsed.luno,
    stn: fields[2] || '',
    mcn,
    panMasked: fields[5] || '',
  };
}

module.exports = { extractWithdrawal };
```

- [ ] **Step 4: 运行测试确认通过**

Run: `node --test test/transactionRequest.test.js`
Expected: PASS（3 tests）

- [ ] **Step 5: 提交**

```bash
git add src/ndc/transactionRequest.js test/transactionRequest.test.js
git commit -m "feat: add withdrawal-request field extractor"
```

---

### Task 4: engine —— 向 handler 注入 `now`

**Files:**
- Modify: `src/engine.js`
- Modify: `test/engine.test.js`（追加一个测试）

**Interfaces:**
- Consumes: 现有 `createEngine`
- Produces: `createEngine({ rules, handlers, now })` 新增可选 `now`（`() => Date`，默认 `() => new Date()`）。
  handler 收到的 `helpers` 从 `{ applyTemplate, ctx, constants }` 扩展为 `{ applyTemplate, ctx, constants, now }`。
  其余行为（三态返回、noReply、匹配）完全不变。

- [ ] **Step 1: 追加失败测试**

在 `test/engine.test.js` 末尾追加：

```js
test('respond injects an overridable now() into handler helpers', () => {
  const fixed = new Date('2026-07-05T09:52:00Z');
  const engine = createEngine({
    rules: [{ name: 'clock', match: { messageClass: '2' }, handler: 'clock' }],
    handlers: { clock: (parsed, session, helpers) => helpers.now().toISOString() },
    now: () => fixed,
  });
  const p = parse(encodeText('22' + FS + '000' + FS + FS + '9'));
  const out = engine.respond(p, createSession());
  assert.strictEqual(out.payload, '2026-07-05T09:52:00.000Z');
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `node --test test/engine.test.js`
Expected: FAIL —— `helpers.now is not a function`

- [ ] **Step 3: 修改 engine.js**

在 `src/engine.js` 中，把 `createEngine` 的签名与 handler 调用改为注入 `now`。

将：

```js
function createEngine({ rules = [], handlers = {} } = {}) {
```

改为：

```js
function createEngine({ rules = [], handlers = {}, now = () => new Date() } = {}) {
```

并把 handler 调用行：

```js
        return { payload: fn(parsed, session, { applyTemplate, ctx, constants }), rule: rule.name };
```

改为：

```js
        return { payload: fn(parsed, session, { applyTemplate, ctx, constants, now }), rule: rule.name };
```

- [ ] **Step 4: 运行测试确认通过**

Run: `node --test test/engine.test.js`
Expected: PASS（7 tests —— 原 6 + 新 1）

- [ ] **Step 5: 提交**

```bash
git add src/engine.js test/engine.test.js
git commit -m "feat: inject overridable now() into engine handler helpers"
```

---

### Task 5: handlers/withdrawal —— 取款 handler 工厂

**Files:**
- Create: `src/handlers/withdrawal.js`
- Create: `test/withdrawal.test.js`

**Interfaces:**
- Consumes: `src/dispense.js`（breakdown）、`src/ndc/transactionReply.js`（buildTransactionReply）、
  `src/ndc/transactionRequest.js`（extractWithdrawal）、`src/constants.js`；handler 签名
  `(parsed, session, helpers)`，`helpers` 含 `now`（Task 4）。
- Produces: `src/handlers/withdrawal.js` 默认导出 `makeWithdrawal(cfg): handler`
  - `cfg` 取自 `config.withdrawal`（见 Task 6）。字段与默认值：
    `cassettes=[50,100,500,1000]`、`approvedNextState='123'`、`returnCard='0'`、
    `amountFieldIndex=8`、`printerFlag='1'`、`includeCam=false`、`camArc='00'`、
    `onDispenseError='decline'`、`receipt={screen:'', printerData:''}`。
  - 返回的 handler：抽取金额 → 若 `amount==null` 或分解 `ok=false` 则返回 `null`（不应答；
    2a 的 decline 钩子最小实现）→ 否则构造 approve reply：
    - `screen` = 用 `applyReceipt` 替换 `cfg.receipt.screen` 的占位符
    - `printer` = `mcn + returnCard + printerFlag + applyReceipt(cfg.receipt.printerData, values)`
    - `cam` = `includeCam ? ('5CAM8A02' + hex(camArc)) : null`
    - `buildTransactionReply({ luno, nextState: approvedNextState, fieldG, screen, printer, cam })`
  - `applyReceipt(tpl, values)`：把 `<AMOUNT> <PAN> <DATE> <TIME> <RECNO> <LUNO>` 及控制字
    `<LF>(0x0A) <FF>(0x0C) <SO>(0x0E) <GS>(0x1D) <SI>(0x0F) <FS>(0x1C)` 替换成实际值/字节。

- [ ] **Step 1: 写失败测试**

Create `test/withdrawal.test.js`:

```js
const test = require('node:test');
const assert = require('node:assert');
const makeWithdrawal = require('../src/handlers/withdrawal');
const { parse } = require('../src/ndc/parser');
const { encodeText } = require('../src/framing');
const { FS, SO } = require('../src/constants');
const { createSession } = require('../src/session');

function withdrawalReq(amount = '00000300') {
  return parse(encodeText(['11', '000', '', '', '15', ';XXXX=XXXX?', '', 'ADC     ', amount].join(FS)));
}
const helpers = {
  applyTemplate: (s) => s,
  ctx: {},
  constants: require('../src/constants'),
  now: () => new Date('2026-07-05T09:52:00Z'),
};

test('approves a withdrawal: class 4, next-state 123, fieldG for amount', () => {
  const handler = makeWithdrawal({ cassettes: [50, 100, 500, 1000], approvedNextState: '123' });
  const out = handler(withdrawalReq('00000300'), createSession(), helpers);
  const f = out.split(FS);
  assert.strictEqual(f[0], '4');
  assert.strictEqual(f[1], '000');
  assert.strictEqual(f[3], '123');
  assert.strictEqual(f[4], '00030000'); // greedy 3x100
});

test('printer block starts with echoed MCN + return-card flag', () => {
  const handler = makeWithdrawal({ returnCard: '0', receipt: { printerData: 'RCPT' } });
  const out = handler(withdrawalReq('00000300'), createSession(), helpers);
  const printer = out.split(FS)[6];
  assert.strictEqual(printer[0], '5'); // MCN echoed from request field[4]='15'
  assert.strictEqual(printer[1], '0'); // return card
});

test('receipt template substitutes amount and control chars', () => {
  const handler = makeWithdrawal({ receipt: { printerData: 'AED <AMOUNT><LF>NO:<SO><RECNO>' } });
  const out = handler(withdrawalReq('00000300'), createSession(), helpers);
  const printer = out.split(FS)[6];
  assert.ok(printer.includes('AED 300.00'));
  assert.ok(printer.includes('\n')); // <LF> → 0x0A
  assert.ok(printer.includes(SO)); // <SO> → 0x0E
});

test('non-dispensable amount → null (decline hook)', () => {
  const handler = makeWithdrawal({ cassettes: [50, 100, 500, 1000] });
  const out = handler(withdrawalReq('00000030'), createSession(), helpers); // 30 not dispensable
  assert.strictEqual(out, null);
});

test('includeCam appends a CAM buffer with ARC', () => {
  const handler = makeWithdrawal({ includeCam: true, camArc: '00' });
  const out = handler(withdrawalReq('00000300'), createSession(), helpers);
  const f = out.split(FS);
  assert.strictEqual(f.length, 8); // …+cam
  assert.ok(f[7].startsWith('5CAM'));
  assert.ok(f[7].endsWith('3030')); // ARC '00' → hex 3030
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `node --test test/withdrawal.test.js`
Expected: FAIL —— `Cannot find module '../src/handlers/withdrawal'`

- [ ] **Step 3: 实现 withdrawal.js**

Create `src/handlers/withdrawal.js`:

```js
const { breakdown } = require('../dispense');
const { buildTransactionReply } = require('../ndc/transactionReply');
const { extractWithdrawal } = require('../ndc/transactionRequest');
const C = require('../constants');

function fmtAmount(n) {
  return n.toFixed(2); // 300 → "300.00"
}
function pad2(n) {
  return String(n).padStart(2, '0');
}
function fmtDate(d) {
  return `${pad2(d.getUTCDate())}/${pad2(d.getUTCMonth() + 1)}/${String(d.getUTCFullYear()).slice(-2)}`;
}
function fmtTime(d) {
  return `${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())}`;
}

function applyReceipt(tpl, values) {
  return String(tpl)
    .replace(/<LF>/g, '\x0a')
    .replace(/<FF>/g, '\x0c')
    .replace(/<SO>/g, C.SO)
    .replace(/<SI>/g, C.SI)
    .replace(/<GS>/g, C.GS)
    .replace(/<FS>/g, C.FS)
    .replace(/<AMOUNT>/g, values.amount)
    .replace(/<PAN>/g, values.pan)
    .replace(/<DATE>/g, values.date)
    .replace(/<TIME>/g, values.time)
    .replace(/<RECNO>/g, values.recno)
    .replace(/<LUNO>/g, values.luno);
}

// ARC 字符串 → ASCII 十六进制（"00" → "3030"）
function arcToHex(arc) {
  return [...String(arc)].map((ch) => ch.charCodeAt(0).toString(16).padStart(2, '0')).join('');
}

module.exports = function makeWithdrawal(cfg = {}) {
  const cassettes = cfg.cassettes || [50, 100, 500, 1000];
  const approvedNextState = cfg.approvedNextState || '123';
  const returnCard = cfg.returnCard || '0';
  const printerFlag = cfg.printerFlag || '1';
  const amountFieldIndex = cfg.amountFieldIndex != null ? cfg.amountFieldIndex : 8;
  const includeCam = cfg.includeCam === true;
  const camArc = cfg.camArc || '00';
  const receipt = cfg.receipt || { screen: '', printerData: '' };

  return function withdrawal(parsed, session, helpers) {
    const req = extractWithdrawal(parsed, { amountFieldIndex });
    if (req.amount == null) return null; // 非法/缺金额 —— decline 钩子最小实现
    const disp = breakdown(req.amount, cassettes);
    if (!disp.ok) return null; // 无法出钞 —— decline 钩子最小实现

    const now = helpers.now ? helpers.now() : new Date();
    const values = {
      amount: fmtAmount(req.amount),
      pan: req.panMasked,
      date: fmtDate(now),
      time: fmtTime(now),
      recno: String(session.nextTvn()),
      luno: req.luno,
    };
    const screen = applyReceipt(receipt.screen || '', values);
    const printer = req.mcn + returnCard + printerFlag + applyReceipt(receipt.printerData || '', values);
    const cam = includeCam ? '5CAM8A02' + arcToHex(camArc) : null;

    return buildTransactionReply({
      luno: req.luno,
      nextState: approvedNextState,
      fieldG: disp.fieldG,
      screen,
      printer,
      cam,
    });
  };
};
```

- [ ] **Step 4: 运行测试确认通过**

Run: `node --test test/withdrawal.test.js`
Expected: PASS（5 tests）

- [ ] **Step 5: 提交**

```bash
git add src/handlers/withdrawal.js test/withdrawal.test.js
git commit -m "feat: add withdrawal transaction handler"
```

---

### Task 6: 装配 —— server.js 接线 + config.json + e2e + README

**Files:**
- Modify: `server.js`
- Modify: `config.json`
- Modify: `README.md`
- Create: `test/e2e.withdrawal.test.js`

**Interfaces:**
- Consumes: 以上全部
- Produces: `createApp` 装配 `withdrawal` handler；config 增加 `withdrawal` 块与取款规则。

- [ ] **Step 1: 写失败的端到端测试**

Create `test/e2e.withdrawal.test.js`:

```js
const test = require('node:test');
const assert = require('node:assert');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');
const { createApp } = require('../server');
const { FS } = require('../src/constants');
const { encodeLength, createDecoder } = require('../src/framing');

test('withdrawal request gets an approved reply (next-state 123 + fieldG) end-to-end', async () => {
  const capDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ndc-wd-'));
  const app = createApp({
    enableTLS: false,
    responseDelayMs: 0,
    captureDir: capDir,
    rules: [
      { name: 'withdrawal-request',
        match: { messageClass: '1', subClass: '1', field: { index: 7, equals: 'ADC     ' } },
        handler: 'withdrawal' },
    ],
    withdrawal: { cassettes: [50, 100, 500, 1000], approvedNextState: '123', receipt: { printerData: 'AED <AMOUNT>' } },
  });
  await new Promise((resolve) => app.server.listen(0, resolve));
  const port = app.server.address().port;

  const reply = await new Promise((resolve, reject) => {
    const dec = createDecoder();
    const req = ['11', '000', '', '', '15', ';XXXX=XXXX?', '', 'ADC     ', '00000300'].join(FS);
    const client = net.createConnection({ port }, () => {
      client.write(encodeLength(Buffer.from(req, 'latin1')));
    });
    client.on('data', (d) => {
      const frames = dec.push(d);
      if (frames.length) { resolve(frames[0].toString('latin1')); client.end(); }
    });
    client.on('error', reject);
  });

  const f = reply.split(FS);
  assert.strictEqual(f[0], '4');       // TransactionReply
  assert.strictEqual(f[3], '123');     // approved next-state
  assert.strictEqual(f[4], '00030000'); // fieldG for 300 (greedy 3x100)
  await new Promise((resolve) => app.server.close(resolve));
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `node --test test/e2e.withdrawal.test.js`
Expected: FAIL —— `Rule "withdrawal-request" references unknown handler "withdrawal"`（handler 未接线）

- [ ] **Step 3: 接线 server.js**

在 `server.js` 中：把顶部 handler 引入与静态 `handlers` 常量改为在 `createApp` 内按 config 构造 `withdrawal`。

将文件顶部：

```js
const goInService = require('./src/handlers/goInService');

const handlers = { goInService };
```

改为（删除模块级 `handlers` 常量，新增 withdrawal 工厂引入）：

```js
const goInService = require('./src/handlers/goInService');
const makeWithdrawal = require('./src/handlers/withdrawal');
```

并在 `function createApp(config) {` 内、`const engine = createEngine(...)` 之前插入：

```js
  const handlers = {
    goInService,
    withdrawal: makeWithdrawal(config.withdrawal || {}),
  };
```

（`createEngine({ rules: config.rules || [], handlers })` 一行保持不变，此时 `handlers` 为局部常量。）

- [ ] **Step 4: 运行端到端测试确认通过**

Run: `node --test test/e2e.withdrawal.test.js`
Expected: PASS（1 test）

- [ ] **Step 5: 迁移 config.json（新增 withdrawal 块 + 规则）**

用以下内容整体替换 `config.json`（在子项目 1 规则前插入取款规则，新增 `withdrawal` 块）：

```json
{
  "port": 2000,
  "enableTLS": false,
  "responseDelayMs": 0,
  "tls": {
    "key": "path/to/key.pem",
    "cert": "path/to/cert.pem"
  },
  "rules": [
    {
      "name": "withdrawal-request",
      "match": { "messageClass": "1", "subClass": "1", "field": { "index": 7, "equals": "ADC     " } },
      "handler": "withdrawal"
    },
    {
      "name": "ready9-go-in-service",
      "match": { "messageClass": "2", "field": { "index": 3, "startsWith": "9" } },
      "handler": "goInService"
    },
    {
      "name": "ready-b-idle-no-reply",
      "match": { "messageClass": "2", "field": { "index": 3, "startsWith": "B" } },
      "noReply": true
    },
    {
      "name": "terminal-state-no-reply",
      "match": { "messageClass": "2", "field": { "index": 3, "startsWith": "F" } },
      "noReply": true
    },
    {
      "name": "unsolicited-status-no-reply",
      "match": { "messageClass": "1", "subClass": "2" },
      "noReply": true
    }
  ],
  "withdrawal": {
    "cassettes": [50, 100, 500, 1000],
    "approvedNextState": "123",
    "returnCard": "0",
    "amountFieldIndex": 8,
    "printerFlag": "1",
    "includeCam": false,
    "camArc": "00",
    "onDispenseError": "decline",
    "receipt": {
      "screen": "",
      "printerData": "<GS>1  CASH WITHDRAWAL<LF>  AED <AMOUNT><LF>  <PAN><LF>  <DATE> <TIME><LF>  REF <RECNO><LF><FF>"
    }
  }
}
```

- [ ] **Step 6: 跑全部测试确认无回归**

Run: `node --test`
Expected: PASS（子项目 1 的 29 + 本子项目新增 = 全部通过）

- [ ] **Step 7: 更新 README.md（交易流程一节 + 校准说明）**

在 `README.md` 的"配置（config.json）"小节之后、"录包"小节之前，插入以下新段落：

````markdown
## 取款交易流程（子项目 2a）

收到取款 TransactionRequest（类 `1`/子 `1`，且请求 field[7]==`"ADC     "`）时，simulator
默认批准并返回 TransactionReply（类 `4`）：下一状态 `123`、按金额贪心分解出的 `fieldG`
出钞指令、退卡、最小凭条。

`config.json` 的 `withdrawal` 块：

- **cassettes**：磁箱面额（低→高，对应 fieldG 的 C1..C4），默认 `[50,100,500,1000]`。
- **approvedNextState**：批准后 ATM 跳转的状态号（默认 `"123"`）。
- **amountFieldIndex**：请求里金额字段索引（默认 `8`）。
- **returnCard** / **printerFlag**：退卡标志 / 打印标志。
- **includeCam** / **camArc**：是否在 reply 追加 CAM/EMV 缓冲及授权响应码（默认关）。
- **receipt.screen** / **receipt.printerData**：屏幕/凭条模板，支持占位符
  `<AMOUNT> <PAN> <DATE> <TIME> <RECNO> <LUNO>` 与控制字 `<LF> <FF> <SO> <SI> <GS> <FS>`。

> **需用真实 ATM 校准的项**（种子取自 AJMN1301 抓包，终端相关）：
> ① 取款识别谓词 `field[7]=="ADC     "` 与金额索引 `8`；② 出钞用贪心分解（金额吻合但
> 与真实主机的混钞不同，ATM 应可接受任意合法组合）；③ **CAM/EMV 缓冲默认关闭**——真实
> 取款 reply 带含 ARPC 密文（tag 91）的 CAM，离线无法计算该密文；若目标 ATM 需要芯片卡
> 在线发卡行认证，需另行提供。余额/转账等其它交易类型属后续子项目 2b。
````

- [ ] **Step 8: 提交**

```bash
git add server.js config.json README.md test/e2e.withdrawal.test.js
git commit -m "feat: wire withdrawal handler with config, rule, and e2e test"
```

---

## Self-Review 结果

**Spec 覆盖检查**（对照 `2026-07-05-transaction-flow-withdrawal-design.md`）：

- §3 dispense.breakdown → Task 1 ✅
- §4.3 transactionReply builder → Task 2 ✅
- §4.2 transactionRequest extractWithdrawal → Task 3 ✅（去掉了 `isWithdrawal`：识别已移入规则 match，extract 只取金额/MCN；余额样本以 `amount==null` 断言）
- §4.4 handler now 注入 → Task 4（engine 改动）✅
- §4.4 withdrawal handler（approve、dispense、凭条、decline 钩子）→ Task 5 ✅
- §5/§6 取款识别写进规则 match + config → Task 6 ✅
- §7 数据流 / §8 错误处理（非取款不命中规则走 UNMATCHED；无法出钞→null）→ Task 5/6 ✅
- §9 测试策略 → Task 1/2/3/5/6 ✅
- §10 构建顺序 → Task 1→6 顺序一致 ✅

**与 spec 的一处刻意偏离（已在 README/plan 标注）**：spec §2.3/§6 将 `includeCam` 默认设为
`true`（ARC `00`）；本 plan 的 shipped config 将其默认设为 `false`。理由：真实 CAM 缓冲含
tag `91` ARPC 密文，离线无法计算，贸然发一个残缺 CAM 风险高于不发；构造器仍支持 `includeCam`，
留待真 ATM 校准。这是最小可用优先的合理精化。

**占位符扫描**：无 TBD/TODO；每个代码步骤均给出完整代码。

**类型一致性**：`breakdown`→`{fieldG,ok,counts}`、`buildTransactionReply(parts)`、
`extractWithdrawal(parsed,cfg)→{amount,luno,stn,mcn,panMasked}`、`makeWithdrawal(cfg)→handler`、
`helpers.now` 在 Task 4 定义、Task 5 消费，签名一致。config 键（cassettes/approvedNextState/
amountFieldIndex/returnCard/printerFlag/includeCam/camArc/receipt）在 Task 5/6 一致。
