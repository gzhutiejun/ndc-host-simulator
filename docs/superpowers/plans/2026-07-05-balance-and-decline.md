# Balance Inquiry + Withdrawal Decline (子项目 2b) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 simulator 能应答余额查询（opcode C 族 → 不出钞、屏幕带可配余额的 class-4 reply），并把 2a 取款的 decline 钩子从"返回 null（静默）"变成返回真实的拒绝 reply（不出钞、decline next-state）。

**Architecture:** 复用 2a 的 `buildTransactionReply` 与 engine。先做两处重构（把 `applyReceipt`/格式化/`arcToHex`/`buildCam` 提取到共享 `src/ndc/receipt.js`；把 `extractWithdrawal` 改名为中性的 `extractRequest`），再扩展 withdrawal 加 decline 分支，最后新增 balance handler 并装配。

**Tech Stack:** Node.js（>=18），零第三方依赖，`node:test` + `node:assert`。

## Global Constraints

- **零第三方依赖**：只允许 Node 内置模块。`package.json` 不得新增依赖。
- **TransactionReply 字段顺序**（FS=0x1C 分隔）：`'4' | LUNO | STN | nextState | fieldG | screen | printer | [CAM]`；余额与拒绝的 `fieldG` 为空串（不出钞）。无 ETX/MAC。
- **opcode 交易族**：请求 field[7] `'ADC     '`=取款；以 `'C'` 开头=查询/余额族。金额在 field[8]。MCN=field[4] 第 2 字符。
- **余额金额**固定可配（`config.balance.amount`）；**拒绝触发**=`maxAmount`（配置了才判，默认 null=不限）或金额无法用磁箱面额凑出；**decline/balance 默认不带 CAM**。
- **占位符**：`<AMOUNT> <BALANCE> <PAN> <DATE> <TIME> <RECNO> <LUNO>` 与控制字 `<LF>(0x0A) <FF>(0x0C) <ESC>(0x1B) <SO>(0x0E) <SI>(0x0F) <GS>(0x1D)`；未提供的占位符替换为空串。**不含 `<FS>`**（会破坏字段边界）。
- **测试命令**：`node --test`（全部）；单文件 `node --test test/<name>.test.js`。
- 基线：main 上 49 个测试通过；每个任务只增不减（重构任务保持数目≥不减）。

## 文件结构

```
src/ndc/receipt.js (new)           共享 applyReceipt + fmt* + arcToHex + buildCam    [Task 1]
src/handlers/withdrawal.js (mod)   改用 receipt.js（Task 1）；decline 分支（Task 3）
src/ndc/transactionRequest.js(mod) extractWithdrawal → extractRequest               [Task 2]
src/handlers/balance.js (new)      makeBalance(cfg) 工厂                              [Task 4]
server.js / config.json (mod)      装配 balance + 规则 + withdrawal 拒绝配置 + e2e   [Task 5]
```

---

### Task 1: 提取共享 `src/ndc/receipt.js` + 重构 withdrawal 改用它

**Files:**
- Create: `src/ndc/receipt.js`
- Create: `test/receipt.test.js`
- Modify: `src/handlers/withdrawal.js`

**Interfaces:**
- Consumes: `src/constants.js`（SO/SI/GS）
- Produces: `src/ndc/receipt.js` 导出
  - `applyReceipt(tpl, values): string` —— 替换控制字 `<LF> <FF> <ESC> <SO> <SI> <GS>` 与值占位符 `<AMOUNT> <BALANCE> <PAN> <DATE> <TIME> <RECNO> <LUNO>`；`values` 缺的键替换为空串。**不含 `<FS>`**。
  - `fmtAmount(n): string` —— `n.toFixed(2)`。
  - `fmtDate(d): string` —— `DD/MM/YY`（UTC）。
  - `fmtTime(d): string` —— `HH:MM`（UTC）。
  - `arcToHex(arc): string` —— ASCII 十六进制（`"00"`→`"3030"`）。
  - `buildCam(arc, include): string|null` —— `include` 为真返回 `'5CAM8A02'+arcToHex(arc)`，否则 `null`。
- withdrawal.js 改为从 receipt.js import 这些，删除内联定义；行为不变。

- [ ] **Step 1: 写失败测试**

Create `test/receipt.test.js`:

```js
const test = require('node:test');
const assert = require('node:assert');
const { applyReceipt, fmtAmount, fmtDate, fmtTime, arcToHex, buildCam } = require('../src/ndc/receipt');
const { SO, SI, GS } = require('../src/constants');

test('applyReceipt substitutes value placeholders and control chars', () => {
  const out = applyReceipt('A=<AMOUNT> B=<BALANCE><LF><ESC>x<SO><SI><GS>', {
    amount: '300.00', balance: '5000.00',
  });
  assert.strictEqual(out, 'A=300.00 B=5000.00\n\x1bx' + SO + SI + GS);
});

test('applyReceipt replaces missing placeholders with empty string', () => {
  assert.strictEqual(applyReceipt('[<PAN>][<RECNO>]', {}), '[][]');
});

test('applyReceipt does NOT treat <FS> as a token (left literal)', () => {
  assert.strictEqual(applyReceipt('a<FS>b', {}), 'a<FS>b');
});

test('fmtAmount / fmtDate / fmtTime use 2 decimals and UTC', () => {
  assert.strictEqual(fmtAmount(300), '300.00');
  const d = new Date('2026-06-02T09:52:00Z');
  assert.strictEqual(fmtDate(d), '02/06/26');
  assert.strictEqual(fmtTime(d), '09:52');
});

test('arcToHex and buildCam', () => {
  assert.strictEqual(arcToHex('00'), '3030');
  assert.strictEqual(buildCam('00', true), '5CAM8A023030');
  assert.strictEqual(buildCam('00', false), null);
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `node --test test/receipt.test.js`
Expected: FAIL —— `Cannot find module '../src/ndc/receipt'`

- [ ] **Step 3: 实现 receipt.js**

Create `src/ndc/receipt.js`:

```js
const C = require('../constants');

function fmtAmount(n) {
  return n.toFixed(2);
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

function applyReceipt(tpl, values = {}) {
  const v = (x) => (x != null ? x : '');
  return String(tpl)
    .replace(/<LF>/g, '\x0a')
    .replace(/<FF>/g, '\x0c')
    .replace(/<ESC>/g, '\x1b')
    .replace(/<SO>/g, C.SO)
    .replace(/<SI>/g, C.SI)
    .replace(/<GS>/g, C.GS)
    .replace(/<AMOUNT>/g, v(values.amount))
    .replace(/<BALANCE>/g, v(values.balance))
    .replace(/<PAN>/g, v(values.pan))
    .replace(/<DATE>/g, v(values.date))
    .replace(/<TIME>/g, v(values.time))
    .replace(/<RECNO>/g, v(values.recno))
    .replace(/<LUNO>/g, v(values.luno));
}

function arcToHex(arc) {
  return [...String(arc)].map((ch) => ch.charCodeAt(0).toString(16).padStart(2, '0')).join('');
}

function buildCam(arc, include) {
  return include ? '5CAM8A02' + arcToHex(arc) : null;
}

module.exports = { applyReceipt, fmtAmount, fmtDate, fmtTime, arcToHex, buildCam };
```

- [ ] **Step 4: 重构 withdrawal.js 改用 receipt.js**

用以下内容整体替换 `src/handlers/withdrawal.js`（删除内联 helpers，改为 import；handler 逻辑不变）：

```js
const { breakdown } = require('../dispense');
const { buildTransactionReply } = require('../ndc/transactionReply');
const { extractWithdrawal } = require('../ndc/transactionRequest');
const { applyReceipt, fmtAmount, fmtDate, fmtTime, buildCam } = require('../ndc/receipt');

module.exports = function makeWithdrawal(cfg = {}) {
  const cassettes = cfg.cassettes || [50, 100, 500, 1000];
  const approvedNextState = cfg.approvedNextState != null ? cfg.approvedNextState : '123';
  const returnCard = cfg.returnCard != null ? cfg.returnCard : '0';
  const printerFlag = cfg.printerFlag != null ? cfg.printerFlag : '1';
  const amountFieldIndex = cfg.amountFieldIndex != null ? cfg.amountFieldIndex : 8;
  const includeCam = cfg.includeCam === true;
  const camArc = cfg.camArc != null ? cfg.camArc : '00';
  const receipt = cfg.receipt || { screen: '', printerData: '' };

  return function withdrawal(parsed, session, helpers) {
    const req = extractWithdrawal(parsed, { amountFieldIndex });
    if (req.amount == null) return null;
    const disp = breakdown(req.amount, cassettes);
    if (!disp.ok) return null;

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
    const cam = buildCam(camArc, includeCam);

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

- [ ] **Step 5: 运行全部测试确认通过（含 2a 回归）**

Run: `node --test`
Expected: PASS（49 原有 + 5 新 receipt = 54；withdrawal.test.js/e2e 仍全绿）

- [ ] **Step 6: 提交**

```bash
git add src/ndc/receipt.js test/receipt.test.js src/handlers/withdrawal.js
git commit -m "refactor: extract shared receipt helpers into src/ndc/receipt.js"
```

---

### Task 2: 重命名 `extractWithdrawal` → `extractRequest`

**Files:**
- Modify: `src/ndc/transactionRequest.js`
- Modify: `src/handlers/withdrawal.js`
- Modify: `test/transactionRequest.test.js`

**Interfaces:**
- Consumes: 无
- Produces: `src/ndc/transactionRequest.js` 导出 `extractRequest(parsed, config)` —— 签名与返回 `{amount, luno, stn, mcn, panMasked}` 与原 `extractWithdrawal` 完全相同，仅改名。

- [ ] **Step 1: 改名测试引用（先让测试指向新名 → 失败）**

在 `test/transactionRequest.test.js` 中，把顶部的
`const { extractWithdrawal } = require('../src/ndc/transactionRequest');`
改为
`const { extractRequest } = require('../src/ndc/transactionRequest');`
并把该文件内所有 `extractWithdrawal(` 调用改为 `extractRequest(`（共 3 处调用）。

- [ ] **Step 2: 运行测试确认失败**

Run: `node --test test/transactionRequest.test.js`
Expected: FAIL —— `extractRequest is not a function`（旧模块仍导出 extractWithdrawal）

- [ ] **Step 3: 在源文件改名**

在 `src/ndc/transactionRequest.js` 中，把函数名与导出从 `extractWithdrawal` 改为 `extractRequest`：
- 第 1 行 `function extractWithdrawal(parsed, config = {}) {` → `function extractRequest(parsed, config = {}) {`
- 末行 `module.exports = { extractWithdrawal };` → `module.exports = { extractRequest };`

在 `src/handlers/withdrawal.js` 中，更新 import 与调用：
- `const { extractWithdrawal } = require('../ndc/transactionRequest');` → `const { extractRequest } = require('../ndc/transactionRequest');`
- `const req = extractWithdrawal(parsed, { amountFieldIndex });` → `const req = extractRequest(parsed, { amountFieldIndex });`

- [ ] **Step 4: 运行全部测试确认通过**

Run: `node --test`
Expected: PASS（54，无回归）

- [ ] **Step 5: 提交**

```bash
git add src/ndc/transactionRequest.js src/handlers/withdrawal.js test/transactionRequest.test.js
git commit -m "refactor: rename extractWithdrawal to extractRequest"
```

---

### Task 3: 取款 decline 分支

**Files:**
- Modify: `src/handlers/withdrawal.js`
- Modify: `test/withdrawal.test.js`（追加 decline 测试）

**Interfaces:**
- Consumes: receipt.js（applyReceipt 等）、`extractRequest`、`buildTransactionReply`、`breakdown`
- Produces: `makeWithdrawal(cfg)` 新增配置 `maxAmount`（默认 `null`）、`declineNextState`（默认 `'048'`）、`declineReceipt`（默认 `{screen:'',printerData:''}`）。行为：`amount==null`→`null`；`(maxAmount!=null && amount>maxAmount)` 或 `breakdown.ok===false`→**decline reply**（class 4、`fieldG:''`、declineNextState、无 CAM）；否则 approve（同 2a）。

- [ ] **Step 1: 追加失败测试**

在 `test/withdrawal.test.js` 末尾追加：

```js
test('declines when amount exceeds maxAmount → class-4 reply, empty fieldG, decline next-state', () => {
  const handler = makeWithdrawal({ maxAmount: 1000, declineNextState: '048', declineReceipt: { printerData: 'DECLINED <AMOUNT>' } });
  const out = handler(withdrawalReq('00005000'), createSession(), helpers); // 5000 > 1000
  assert.notStrictEqual(out, null);
  const f = out.split(FS);
  assert.strictEqual(f[0], '4');
  assert.strictEqual(f[3], '048');   // decline next-state
  assert.strictEqual(f[4], '');      // no dispense
  assert.ok(f[6].includes('DECLINED 5000.00'));
});

test('declines a non-dispensable amount with a reply (not null)', () => {
  const handler = makeWithdrawal({ declineNextState: '048' });
  const out = handler(withdrawalReq('00000030'), createSession(), helpers); // 30 not dispensable
  assert.notStrictEqual(out, null);
  const f = out.split(FS);
  assert.strictEqual(f[3], '048');
  assert.strictEqual(f[4], '');
});

test('still approves a normal within-limit dispensable amount', () => {
  const handler = makeWithdrawal({ maxAmount: 10000 });
  const out = handler(withdrawalReq('00000300'), createSession(), helpers);
  const f = out.split(FS);
  assert.strictEqual(f[3], '123'); // approved
  assert.strictEqual(f[4], '00030000');
});

test('missing amount still returns null', () => {
  const handler = makeWithdrawal({});
  const p = parse(encodeText(['11', '000', '', '', '15', ';X=X?', '', 'ADC     ', ''].join(FS)));
  assert.strictEqual(handler(p, createSession(), helpers), null);
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `node --test test/withdrawal.test.js`
Expected: FAIL（decline 分支未实现：超限/不可出钞目前返回 null，`out.split` 抛错或断言失败）

- [ ] **Step 3: 实现 decline 分支**

用以下内容整体替换 `src/handlers/withdrawal.js`：

```js
const { breakdown } = require('../dispense');
const { buildTransactionReply } = require('../ndc/transactionReply');
const { extractRequest } = require('../ndc/transactionRequest');
const { applyReceipt, fmtAmount, fmtDate, fmtTime, buildCam } = require('../ndc/receipt');

module.exports = function makeWithdrawal(cfg = {}) {
  const cassettes = cfg.cassettes || [50, 100, 500, 1000];
  const approvedNextState = cfg.approvedNextState != null ? cfg.approvedNextState : '123';
  const declineNextState = cfg.declineNextState != null ? cfg.declineNextState : '048';
  const returnCard = cfg.returnCard != null ? cfg.returnCard : '0';
  const printerFlag = cfg.printerFlag != null ? cfg.printerFlag : '1';
  const amountFieldIndex = cfg.amountFieldIndex != null ? cfg.amountFieldIndex : 8;
  const maxAmount = cfg.maxAmount != null ? cfg.maxAmount : null;
  const includeCam = cfg.includeCam === true;
  const camArc = cfg.camArc != null ? cfg.camArc : '00';
  const receipt = cfg.receipt || { screen: '', printerData: '' };
  const declineReceipt = cfg.declineReceipt || { screen: '', printerData: '' };

  return function withdrawal(parsed, session, helpers) {
    const req = extractRequest(parsed, { amountFieldIndex });
    if (req.amount == null) return null;

    const now = helpers.now ? helpers.now() : new Date();
    const values = {
      amount: fmtAmount(req.amount),
      pan: req.panMasked,
      date: fmtDate(now),
      time: fmtTime(now),
      recno: String(session.nextTvn()),
      luno: req.luno,
    };

    const disp = breakdown(req.amount, cassettes);
    const declined = (maxAmount != null && req.amount > maxAmount) || !disp.ok;

    if (declined) {
      const screen = applyReceipt(declineReceipt.screen || '', values);
      const printer = req.mcn + returnCard + printerFlag + applyReceipt(declineReceipt.printerData || '', values);
      return buildTransactionReply({
        luno: req.luno,
        nextState: declineNextState,
        fieldG: '',
        screen,
        printer,
        cam: null,
      });
    }

    const screen = applyReceipt(receipt.screen || '', values);
    const printer = req.mcn + returnCard + printerFlag + applyReceipt(receipt.printerData || '', values);
    const cam = buildCam(camArc, includeCam);
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

- [ ] **Step 4: 运行全部测试确认通过**

Run: `node --test`
Expected: PASS（54 + 4 新 decline = 58；原 2a withdrawal 测试仍绿）

- [ ] **Step 5: 提交**

```bash
git add src/handlers/withdrawal.js test/withdrawal.test.js
git commit -m "feat: emit a real decline reply for over-limit/non-dispensable withdrawals"
```

---

### Task 4: 余额 handler `src/handlers/balance.js`

**Files:**
- Create: `src/handlers/balance.js`
- Create: `test/balance.test.js`

**Interfaces:**
- Consumes: `buildTransactionReply`、`extractRequest`、receipt.js（applyReceipt/fmtDate/fmtTime/buildCam）；handler 签名 `(parsed, session, helpers)`，`helpers.now` 提供日期时间。
- Produces: `src/handlers/balance.js` 默认导出 `makeBalance(cfg): handler`
  - `cfg` 取自 `config.balance`。默认：`nextState='074'`、`amount='5000.00'`、`returnCard='0'`、`printerFlag='1'`、`includeCam=false`、`camArc='00'`、`receipt={screen,printerData}`。
  - handler 返回 class-4 reply：`fieldG` 空、next-state=cfg.nextState、screen/printer 用 `applyReceipt` 套模板（`<BALANCE>`=cfg.amount）、printer 前缀回显 MCN+returnCard+printerFlag、CAM 由 `buildCam(camArc, includeCam)`。

- [ ] **Step 1: 写失败测试**

Create `test/balance.test.js`:

```js
const test = require('node:test');
const assert = require('node:assert');
const makeBalance = require('../src/handlers/balance');
const { parse } = require('../src/ndc/parser');
const { encodeText } = require('../src/framing');
const { FS } = require('../src/constants');
const { createSession } = require('../src/session');

function balanceReq(opcode = 'CC   C  ') {
  return parse(encodeText(['11', '000', '', '', '15', ';XXXX=XXXX?', '', opcode, ''].join(FS)));
}
const helpers = {
  applyTemplate: (s) => s,
  ctx: {},
  constants: require('../src/constants'),
  now: () => new Date('2026-06-02T09:52:00Z'),
};

test('balance inquiry: class 4, next-state 074, empty fieldG, balance in screen', () => {
  const handler = makeBalance({ nextState: '074', amount: '5000.00', receipt: { screen: 'BAL <BALANCE>', printerData: '' } });
  const out = handler(balanceReq(), createSession(), helpers);
  const f = out.split(FS);
  assert.strictEqual(f[0], '4');
  assert.strictEqual(f[3], '074');
  assert.strictEqual(f[4], '');            // no dispense
  assert.strictEqual(f[5], 'BAL 5000.00'); // balance rendered into screen
});

test('printer block echoes MCN + return-card + flag', () => {
  const handler = makeBalance({ returnCard: '0', printerFlag: '1', receipt: { printerData: 'RCPT' } });
  const out = handler(balanceReq(), createSession(), helpers);
  const printer = out.split(FS)[6];
  assert.strictEqual(printer.slice(0, 3), '501'); // MCN '5' (field[4]='15') + '0' + '1'
});

test('no CAM by default (7 fields)', () => {
  const handler = makeBalance({});
  const out = handler(balanceReq(), createSession(), helpers);
  assert.strictEqual(out.split(FS).length, 7);
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `node --test test/balance.test.js`
Expected: FAIL —— `Cannot find module '../src/handlers/balance'`

- [ ] **Step 3: 实现 balance.js**

Create `src/handlers/balance.js`:

```js
const { buildTransactionReply } = require('../ndc/transactionReply');
const { extractRequest } = require('../ndc/transactionRequest');
const { applyReceipt, fmtDate, fmtTime, buildCam } = require('../ndc/receipt');

module.exports = function makeBalance(cfg = {}) {
  const nextState = cfg.nextState != null ? cfg.nextState : '074';
  const amount = cfg.amount != null ? cfg.amount : '5000.00';
  const returnCard = cfg.returnCard != null ? cfg.returnCard : '0';
  const printerFlag = cfg.printerFlag != null ? cfg.printerFlag : '1';
  const includeCam = cfg.includeCam === true;
  const camArc = cfg.camArc != null ? cfg.camArc : '00';
  const receipt = cfg.receipt || { screen: '', printerData: '' };

  return function balance(parsed, session, helpers) {
    const req = extractRequest(parsed);
    const now = helpers.now ? helpers.now() : new Date();
    const values = {
      balance: amount,
      pan: req.panMasked,
      date: fmtDate(now),
      time: fmtTime(now),
      recno: String(session.nextTvn()),
      luno: req.luno,
    };
    const screen = applyReceipt(receipt.screen || '', values);
    const printer = req.mcn + returnCard + printerFlag + applyReceipt(receipt.printerData || '', values);
    const cam = buildCam(camArc, includeCam);
    return buildTransactionReply({
      luno: req.luno,
      nextState,
      fieldG: '',
      screen,
      printer,
      cam,
    });
  };
};
```

- [ ] **Step 4: 运行全部测试确认通过**

Run: `node --test`
Expected: PASS（58 + 3 新 balance = 61）

- [ ] **Step 5: 提交**

```bash
git add src/handlers/balance.js test/balance.test.js
git commit -m "feat: add balance-inquiry transaction handler"
```

---

### Task 5: 装配 —— server.js + config.json + e2e + README

**Files:**
- Modify: `server.js`
- Modify: `config.json`
- Modify: `README.md`
- Create: `test/e2e.balance-decline.test.js`

**Interfaces:**
- Consumes: `makeBalance`、更新后的 `makeWithdrawal`
- Produces: `createApp` 装配 balance handler；config 增加 balance 规则/块与 withdrawal 拒绝配置。

- [ ] **Step 1: 写失败的端到端测试**

Create `test/e2e.balance-decline.test.js`:

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

function sendFrame(port, payload) {
  return new Promise((resolve, reject) => {
    const dec = createDecoder();
    const client = net.createConnection({ port }, () => {
      client.write(encodeLength(Buffer.from(payload, 'latin1')));
    });
    client.on('data', (d) => {
      const frames = dec.push(d);
      if (frames.length) { resolve(frames[0].toString('latin1')); client.end(); }
    });
    client.on('error', reject);
  });
}

function makeApp() {
  const capDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ndc-bd-'));
  return createApp({
    enableTLS: false, responseDelayMs: 0, captureDir: capDir,
    rules: [
      { name: 'withdrawal-request', match: { messageClass: '1', subClass: '1', field: { index: 7, equals: 'ADC     ' } }, handler: 'withdrawal' },
      { name: 'balance-inquiry', match: { messageClass: '1', subClass: '1', field: { index: 7, startsWith: 'C' } }, handler: 'balance' },
    ],
    withdrawal: { cassettes: [50, 100, 500, 1000], approvedNextState: '123', maxAmount: 1000, declineNextState: '048', declineReceipt: { printerData: 'DECLINED' } },
    balance: { nextState: '074', amount: '5000.00', receipt: { screen: 'BAL <BALANCE>', printerData: '' } },
  });
}

test('balance inquiry gets a 074 reply carrying the configured balance', { timeout: 5000 }, async () => {
  const app = makeApp();
  await new Promise((resolve) => app.server.listen(0, resolve));
  const reply = await sendFrame(app.server.address().port, ['11', '000', '', '', '15', ';X=X?', '', 'CC   C  ', ''].join(FS));
  const f = reply.split(FS);
  assert.strictEqual(f[0], '4');
  assert.strictEqual(f[3], '074');
  assert.strictEqual(f[4], '');
  assert.ok(f[5].includes('5000.00'));
  await new Promise((resolve) => app.server.close(resolve));
});

test('over-limit withdrawal gets a 048 decline reply with no dispense', { timeout: 5000 }, async () => {
  const app = makeApp();
  await new Promise((resolve) => app.server.listen(0, resolve));
  const reply = await sendFrame(app.server.address().port, ['11', '000', '', '', '15', ';X=X?', '', 'ADC     ', '00005000'].join(FS));
  const f = reply.split(FS);
  assert.strictEqual(f[0], '4');
  assert.strictEqual(f[3], '048');
  assert.strictEqual(f[4], '');
  await new Promise((resolve) => app.server.close(resolve));
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `node --test test/e2e.balance-decline.test.js`
Expected: FAIL —— `Rule "balance-inquiry" references unknown handler "balance"`（balance 未接线）

- [ ] **Step 3: 接线 server.js**

在 `server.js` 顶部，`const makeWithdrawal = require('./src/handlers/withdrawal');` 之后，加一行：

```js
const makeBalance = require('./src/handlers/balance');
```

在 `createApp` 内构造 handlers 的那处，把：

```js
  const handlers = {
    goInService,
    withdrawal: makeWithdrawal(config.withdrawal || {}),
  };
```

改为：

```js
  const handlers = {
    goInService,
    withdrawal: makeWithdrawal(config.withdrawal || {}),
    balance: makeBalance(config.balance || {}),
  };
```

- [ ] **Step 4: 运行端到端测试确认通过**

Run: `node --test test/e2e.balance-decline.test.js`
Expected: PASS（2 tests）

- [ ] **Step 5: 迁移 config.json**

用以下内容整体替换 `config.json`（新增 `balance-inquiry` 规则、`balance` 块，并给 `withdrawal` 块加拒绝配置）：

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
      "name": "balance-inquiry",
      "match": { "messageClass": "1", "subClass": "1", "field": { "index": 7, "startsWith": "C" } },
      "handler": "balance"
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
    "declineNextState": "048",
    "maxAmount": null,
    "returnCard": "0",
    "amountFieldIndex": 8,
    "printerFlag": "1",
    "includeCam": false,
    "camArc": "00",
    "receipt": {
      "screen": "",
      "printerData": "<GS>1  CASH WITHDRAWAL<LF>  AED <AMOUNT><LF>  <PAN><LF>  <DATE> <TIME><LF>  REF <RECNO><LF><FF>"
    },
    "declineReceipt": {
      "screen": "",
      "printerData": "<GS>1  WITHDRAWAL DECLINED<LF>  AED <AMOUNT><LF>  <DATE> <TIME><LF><FF>"
    }
  },
  "balance": {
    "nextState": "074",
    "amount": "5000.00",
    "returnCard": "0",
    "printerFlag": "1",
    "includeCam": false,
    "camArc": "00",
    "receipt": {
      "screen": "074075<ESC>[20;80m<SI>FG      <BALANCE> ",
      "printerData": "<GS>1  BALANCE INQUIRY<LF>  AVAIL BAL: AED <BALANCE><LF>  <DATE> <TIME><LF><FF>"
    }
  }
}
```

- [ ] **Step 6: 跑全部测试确认无回归**

Run: `node --test`
Expected: PASS（61 + 2 新 e2e = 63，全部通过）

- [ ] **Step 7: 更新 README.md**

在 `README.md` 的"取款交易流程（子项目 2a）"小节之后、"录包"小节之前，插入：

````markdown
## 余额查询与取款拒绝（子项目 2b）

**余额查询**：收到查询类请求（field[7] 以 `C` 开头）时，返回 class-4 reply：下一状态 `074`、
**不出钞**（fieldG 空）、屏幕字段带**可配的固定余额**。`config.json` 的 `balance` 块：

- **nextState**：查询后 ATM 跳转状态（默认 `"074"`）。
- **amount**：返回的固定余额（默认 `"5000.00"`），填入 screen/printer 模板的 `<BALANCE>`。
- **returnCard** / **printerFlag** / **includeCam** / **camArc**：同取款。
- **receipt.screen** / **receipt.printerData**：屏幕/凭条模板，支持 `<BALANCE> <PAN> <DATE> <TIME> <RECNO> <LUNO>` 与控制字 `<LF> <FF> <ESC> <SO> <SI> <GS>`。

**取款拒绝**：`withdrawal` 块新增 `maxAmount`（默认 `null`=不主动限额）与 `declineNextState`
（默认 `"048"`）、`declineReceipt`。当取款金额超过 `maxAmount`，或金额无法用磁箱面额凑出时，
返回 class-4 **拒绝** reply：`declineNextState`、**不出钞**、拒绝凭条、不带 CAM。

> **需真 ATM 校准**：余额识别用 `field[7] startsWith "C"` 粗匹配整个查询族，next-state 统一
> `074`（真实中 077/151/134 因子类型而异）；余额 screen 模板（含 `<ESC>[20;80m<SI>FG` 定位）
> 与 decline next-state `048` 均为抓包种子。其它交易类型（转账/存款/改密）属后续子项目。
````

- [ ] **Step 8: 提交**

```bash
git add server.js config.json README.md test/e2e.balance-decline.test.js
git commit -m "feat: wire balance handler + withdrawal decline config with e2e tests"
```

---

## Self-Review 结果

**Spec 覆盖检查**（对照 `2026-07-05-balance-and-decline-design.md`）：

- §3.1 提取 receipt.js（applyReceipt+`<BALANCE>`/`<ESC>`+buildCam+格式化）→ Task 1 ✅
- §3.1 重命名 extractWithdrawal→extractRequest → Task 2 ✅
- §3.3 取款 decline（maxAmount/declineNextState/declineReceipt + 真实拒绝 reply）→ Task 3 ✅
- §3.2 balance handler（C 族、不出钞、屏幕带余额、fieldG 空）→ Task 4 ✅
- §4 config（balance 规则/块、withdrawal 拒绝配置）→ Task 5 ✅
- §5 数据流（ADC→withdrawal、C→balance、其它 UNMATCHED）→ Task 5 e2e ✅
- §6 错误处理（金额缺失→null；非 A/C 族→UNMATCHED）→ Task 3/4 ✅
- §7 测试策略 → Task 1/3/4/5 ✅
- §8 构建顺序 → Task 1→5 一致 ✅

**占位符扫描**：无 TBD/TODO；每个改代码的步骤均给出完整代码。

**类型一致性**：`applyReceipt(tpl,values)`、`buildCam(arc,include)`、`fmtAmount/fmtDate/fmtTime`
（Task 1 产出）在 Task 3/4 消费一致；`extractRequest(parsed,config)`（Task 2 产出）在 Task 3/4 一致；
`makeBalance(cfg)`/`makeWithdrawal(cfg)` 工厂签名与 config 键（nextState/amount/maxAmount/
declineNextState/declineReceipt/receipt）在 Task 3/4/5 一致；`buildTransactionReply` 空 fieldG 用法
与 2a 一致。测试基线数目递增（49→54→54→58→61→63）自洽。
