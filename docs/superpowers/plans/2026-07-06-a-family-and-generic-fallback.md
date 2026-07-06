# A-Family Withdrawal Relaxation + Generic Fallback (子项目 2c) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把取款规则从只匹配 `field[7]=="ADC     "` 放宽到整个 A 族（`startsWith "A"`），并新增通用兜底 handler，让任何未被取款(A)/余额(C)匹配的 class1-sub1 TxnRequest 都能收到一个安全的 class-4"取消/无法完成"reply（048、不出钞、退卡），杜绝真实 ATM 交易请求超时。

**Architecture:** 零引擎改动（engine 已支持 `startsWith` 与多规则 `find`）。A 族放宽只改 config.json 一处 match。通用兜底新增 `src/handlers/generic.js`，结构对标 balance handler（不出钞、fieldG 空、无 CAM），但无余额金额、next-state 默认 048、永不返回 null。generic 规则作为 class1-sub1 无 field 约束的兜底，**必须排在 withdrawal(A) 与 balance(C) 之后**。

**Tech Stack:** Node.js（>=18），零第三方依赖，`node:test` + `node:assert`。

## Global Constraints

- **零第三方依赖**：只允许 Node 内置模块。`package.json` 不得新增依赖。
- **零引擎改动**：`src/engine.js` 不改（`matches` 已支持 `equals`/`startsWith`，`respond` 用 `rules.find` 首个匹配即优先级）。
- **TransactionReply 字段顺序**（FS=0x1C 分隔）：`'4' | LUNO | STN | nextState | fieldG | screen | printer | [CAM]`；兜底的 `fieldG` 为空串（不出钞），`cam=null`（7 字段，无 CAM）。无 ETX/MAC。
- **opcode 交易族**：请求 field[7]（8 字符）首字符区分族——`A*`=取款（全族出钞，approve 123 / decline 048）；`C*`=查询；其它（`D*`/`I*`/空 等）=通用兜底。金额在 field[8]。MCN=field[4] 第 2 字符。
- **规则优先级**：engine 用 `rules.find` 取首个匹配。class1-sub1 内顺序必须为 withdrawal(A) → balance(C) → generic(无 field 约束兜底)。generic 是 sub1，与 `unsolicited-status-no-reply`(sub2) 不冲突。
- **A 族按金额判定（已确认）**：A 族全部走现有 withdrawal handler，仅按可兑现性 + `maxAmount` 批准/拒绝；`maxAmount` 保持 `null`。handler 本身不改。
- **generic 永不返回 null**：对任意 class1-sub1 请求都构造合法 reply（不依赖金额），这是"无 TxnRequest 被晾着"的关键。
- **占位符**：`applyReceipt` 支持 `<PAN> <DATE> <TIME> <RECNO> <LUNO>` 等与控制字 `<LF> <FF> <ESC> <SO> <SI> <GS>`；未提供的占位符替换为空串；**不含 `<FS>`**。
- **测试命令**：`node --test`（全部）；单文件 `node --test test/<name>.test.js`。
- 基线：main（本子项目起点）63 个测试通过；每个任务只增不减。

## 文件结构

```
config.json (mod)              withdrawal-request equals→startsWith "A"（Task 1）；generic 块 + generic-fallback 规则（Task 3）
src/handlers/generic.js (new)  makeGeneric(cfg) 工厂                              [Task 2]
server.js (mod)                装配 generic handler                              [Task 3]
README.md (mod)                A 族放宽 + 通用兜底一节                            [Task 3]
test/withdrawal.test.js (mod)  A 族变体（AAC/ABC）命中并批准                      [Task 1]
test/generic.test.js (new)     generic handler 单测                              [Task 2]
test/e2e.generic-fallback.test.js (new) A 族变体命中取款 / 非 A-C 族命中兜底 e2e  [Task 3]
```

---

### Task 1: A 族取款放宽（config + 变体测试）

**Files:**
- Modify: `config.json`（`withdrawal-request` 规则 match）
- Modify: `test/withdrawal.test.js`（追加 A 族变体测试）

**Interfaces:**
- Consumes: 现有 `makeWithdrawal(cfg)`（不改）、`src/engine.js` 的 `matches`（不改）。
- Produces: 无新导出。仅使 `withdrawal-request` 规则匹配任意 field[7] 以 `"A"` 开头的 class1-sub1 请求。

**说明：** `test/withdrawal.test.js` 直接测 handler，handler 对 opcode 首字符不敏感（只看金额），所以 handler 层面 AAC/ABC 与 ADC 行为本就一致。本任务的变体测试通过 **engine.matches** 验证"A 族被 withdrawal 规则捕获、C 族不被抢走"，这才是放宽的真正行为点。先在 withdrawal.test.js 里加 matches 层断言。

- [ ] **Step 1: 写失败测试（放宽后的规则匹配）**

在 `test/withdrawal.test.js` 顶部 import 区补充（若尚未 import）：

```js
const { matches } = require('../src/engine');
```

在文件末尾追加：

```js
const AFAM_RULE = { messageClass: '1', subClass: '1', field: { index: 7, startsWith: 'A' } };

function reqWithOpcode(opcode) {
  return parse(encodeText(['11', '000', '', '', '15', ';XXXX=XXXX?', '', opcode, '00000300'].join(FS)));
}

test('relaxed A-family rule matches ADC / AAC / ABC variants', () => {
  assert.strictEqual(matches(AFAM_RULE, reqWithOpcode('ADC     ')), true);
  assert.strictEqual(matches(AFAM_RULE, reqWithOpcode('AAC     ')), true);
  assert.strictEqual(matches(AFAM_RULE, reqWithOpcode('ABC     ')), true);
});

test('relaxed A-family rule does NOT match C-family (balance) opcodes', () => {
  assert.strictEqual(matches(AFAM_RULE, reqWithOpcode('CC   C  ')), false);
});

test('AAC variant still approves a normal dispensable amount via withdrawal handler', () => {
  const handler = makeWithdrawal({});
  const out = handler(reqWithOpcode('AAC     '), createSession(), helpers);
  const f = out.split(FS);
  assert.strictEqual(f[0], '4');
  assert.strictEqual(f[3], '123'); // approved
  assert.strictEqual(f[4], '00030000'); // dispense for 300
});
```

> 注：`FS`、`parse`、`encodeText`、`makeWithdrawal`、`createSession`、`helpers` 在 `test/withdrawal.test.js` 顶部已 import（沿用 2a/2b 的 fixture）。若 `helpers` 或 `createSession` 未在该文件定义，复用文件内既有的同名 fixture；不要重复定义。执行前先读该文件顶部确认已有符号，仅补 `matches`。

- [ ] **Step 2: 运行测试确认失败**

Run: `node --test test/withdrawal.test.js`
Expected: FAIL —— 若 `matches` 未 import 则 `matches is not a function`；`reqWithOpcode`/`AFAM_RULE` 断言在放宽逻辑上应通过（matches 本就支持 startsWith），但 **AAC/ABC 变体测试** 是新增覆盖，主要防回归。实际"红"点：确保新加的 import 与 fixture 无语法错误、断言全绿前 config 未改。

> 如果 Step 1 的所有断言直接通过（因为 `matches` 是纯函数、config 尚未参与 handler 单测），这是正常的——这些测试是**放宽行为的回归护栏**。继续 Step 3 改 config 使端到端也放宽。

- [ ] **Step 3: 放宽 config.json 的 withdrawal 规则**

在 `config.json` 中，把 `withdrawal-request` 规则的 match 从：

```json
      "match": { "messageClass": "1", "subClass": "1", "field": { "index": 7, "equals": "ADC     " } },
```

改为：

```json
      "match": { "messageClass": "1", "subClass": "1", "field": { "index": 7, "startsWith": "A" } },
```

（只改这一行的 `"field"`：`"equals": "ADC     "` → `"startsWith": "A"`。其余规则与 withdrawal 配置块不动。）

- [ ] **Step 4: 运行全部测试确认通过（含回归）**

Run: `node --test`
Expected: PASS（63 原有 + 3 新 = 66；原 ADC e2e/单测仍全绿）

- [ ] **Step 5: 提交**

```bash
git add config.json test/withdrawal.test.js
git commit -m "feat: relax withdrawal rule to match the whole A opcode family"
```

---

### Task 2: 通用兜底 handler `src/handlers/generic.js`

**Files:**
- Create: `src/handlers/generic.js`
- Create: `test/generic.test.js`

**Interfaces:**
- Consumes: `buildTransactionReply`（`src/ndc/transactionReply.js`）、`extractRequest`（`src/ndc/transactionRequest.js`）、`applyReceipt`/`fmtDate`/`fmtTime`/`buildCam`（`src/ndc/receipt.js`）；handler 签名 `(parsed, session, helpers)`，`helpers.now` 提供时间。
- Produces: `src/handlers/generic.js` 默认导出 `makeGeneric(cfg): handler`
  - `cfg` 取自 `config.generic`。默认：`nextState='048'`、`returnCard='0'`、`printerFlag='1'`、`includeCam=false`、`camArc='00'`、`receipt={screen:'', printerData:''}`。
  - handler 对**任意** class1-sub1 请求返回 class-4 reply：`fieldG` 空（不出钞）、next-state=cfg.nextState、screen/printer 用 `applyReceipt` 套模板、printer 前缀回显 `MCN+returnCard+printerFlag`、CAM 由 `buildCam(camArc, includeCam)`（默认 null）。**绝不返回 null**（不依赖金额）。`recno` 用 `session.nextTvn()`。

- [ ] **Step 1: 写失败测试**

Create `test/generic.test.js`:

```js
const test = require('node:test');
const assert = require('node:assert');
const makeGeneric = require('../src/handlers/generic');
const { parse } = require('../src/ndc/parser');
const { encodeText } = require('../src/framing');
const { FS } = require('../src/constants');
const { createSession } = require('../src/session');

function txnReq(opcode = 'D       ', amount = '') {
  return parse(encodeText(['11', '000', '', '', '15', ';XXXX=XXXX?', '', opcode, amount].join(FS)));
}
const helpers = {
  applyTemplate: (s) => s,
  ctx: {},
  constants: require('../src/constants'),
  now: () => new Date('2026-06-02T09:52:00Z'),
};

test('generic fallback: class 4, next-state 048, empty fieldG, always a reply', () => {
  const handler = makeGeneric({});
  const out = handler(txnReq('D       '), createSession(), helpers);
  assert.notStrictEqual(out, null);
  const f = out.split(FS);
  assert.strictEqual(f[0], '4');
  assert.strictEqual(f[3], '048'); // safe cancel next-state
  assert.strictEqual(f[4], '');    // no dispense
});

test('generic fallback: no CAM by default (7 fields)', () => {
  const handler = makeGeneric({});
  const out = handler(txnReq('I       '), createSession(), helpers);
  assert.strictEqual(out.split(FS).length, 7);
});

test('generic fallback: never returns null even with empty opcode and no amount', () => {
  const handler = makeGeneric({});
  const out = handler(txnReq('', ''), createSession(), helpers);
  assert.notStrictEqual(out, null);
  assert.strictEqual(out.split(FS)[0], '4');
});

test('generic fallback: nextState is configurable', () => {
  const handler = makeGeneric({ nextState: '138' });
  const out = handler(txnReq('D       '), createSession(), helpers);
  assert.strictEqual(out.split(FS)[3], '138');
});

test('generic fallback: printer block echoes MCN + return-card + flag and renders template', () => {
  const handler = makeGeneric({ returnCard: '0', printerFlag: '1', receipt: { printerData: 'CANCELLED <RECNO>' } });
  const out = handler(txnReq('D       '), createSession(), helpers);
  const printer = out.split(FS)[6];
  assert.strictEqual(printer.slice(0, 3), '501'); // MCN '5' (field[4]='15') + '0' + '1'
  assert.ok(printer.includes('CANCELLED 1')); // first nextTvn() → recno 1
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `node --test test/generic.test.js`
Expected: FAIL —— `Cannot find module '../src/handlers/generic'`

- [ ] **Step 3: 实现 generic.js**

Create `src/handlers/generic.js`:

```js
const { buildTransactionReply } = require('../ndc/transactionReply');
const { extractRequest } = require('../ndc/transactionRequest');
const { applyReceipt, fmtDate, fmtTime, buildCam } = require('../ndc/receipt');

module.exports = function makeGeneric(cfg = {}) {
  const nextState = cfg.nextState != null ? cfg.nextState : '048';
  const returnCard = cfg.returnCard != null ? cfg.returnCard : '0';
  const printerFlag = cfg.printerFlag != null ? cfg.printerFlag : '1';
  const includeCam = cfg.includeCam === true;
  const camArc = cfg.camArc != null ? cfg.camArc : '00';
  const receipt = cfg.receipt || { screen: '', printerData: '' };

  return function generic(parsed, session, helpers) {
    const req = extractRequest(parsed);
    const now = helpers.now ? helpers.now() : new Date();
    const values = {
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
Expected: PASS（66 + 5 新 generic = 71）

- [ ] **Step 5: 提交**

```bash
git add src/handlers/generic.js test/generic.test.js
git commit -m "feat: add generic fallback transaction handler"
```

---

### Task 3: 装配 —— server.js + config.json 规则 + e2e + README

**Files:**
- Modify: `server.js`
- Modify: `config.json`
- Modify: `README.md`
- Create: `test/e2e.generic-fallback.test.js`

**Interfaces:**
- Consumes: `makeGeneric`（Task 2）、已放宽的 `withdrawal-request` 规则（Task 1）。
- Produces: `createApp` 的 handlers 增加 `generic: makeGeneric(config.generic || {})`；config 增加 `generic` 块与 `generic-fallback` 规则（置于 withdrawal/balance 之后、状态类规则之前或之后均可，只要在同为 class1-sub1 的 withdrawal/balance 之后）。

- [ ] **Step 1: 写失败的端到端测试**

Create `test/e2e.generic-fallback.test.js`:

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
    let settled = false;
    client.on('data', (d) => {
      const frames = dec.push(d);
      if (frames.length && !settled) { settled = true; resolve(frames[0].toString('latin1')); client.end(); }
    });
    client.on('close', () => { if (!settled) { settled = true; reject(new Error('closed with no frame')); } });
    client.on('error', reject);
  });
}

function makeApp() {
  const capDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ndc-gen-'));
  return createApp({
    enableTLS: false, responseDelayMs: 0, captureDir: capDir,
    rules: [
      { name: 'withdrawal-request', match: { messageClass: '1', subClass: '1', field: { index: 7, startsWith: 'A' } }, handler: 'withdrawal' },
      { name: 'balance-inquiry', match: { messageClass: '1', subClass: '1', field: { index: 7, startsWith: 'C' } }, handler: 'balance' },
      { name: 'generic-fallback', match: { messageClass: '1', subClass: '1' }, handler: 'generic' },
    ],
    withdrawal: { cassettes: [50, 100, 500, 1000], approvedNextState: '123' },
    balance: { nextState: '074', amount: '5000.00', receipt: { screen: 'BAL <BALANCE>', printerData: '' } },
    generic: { nextState: '048', receipt: { screen: '', printerData: '' } },
  });
}

test('AAC withdrawal variant is approved (relaxed A-family match)', { timeout: 5000 }, async () => {
  const app = makeApp();
  await new Promise((resolve) => app.server.listen(0, resolve));
  const reply = await sendFrame(app.server.address().port, ['11', '000', '', '', '15', ';X=X?', '', 'AAC     ', '00000300'].join(FS));
  const f = reply.split(FS);
  assert.strictEqual(f[0], '4');
  assert.strictEqual(f[3], '123');       // approved
  assert.strictEqual(f[4], '00030000');  // dispense for 300
  await new Promise((resolve) => app.server.close(resolve));
});

test('non A/C TxnRequest (D-family) gets a 048 generic fallback reply, no dispense', { timeout: 5000 }, async () => {
  const app = makeApp();
  await new Promise((resolve) => app.server.listen(0, resolve));
  const reply = await sendFrame(app.server.address().port, ['11', '000', '', '', '15', ';X=X?', '', 'D       ', ''].join(FS));
  const f = reply.split(FS);
  assert.strictEqual(f[0], '4');
  assert.strictEqual(f[3], '048'); // safe cancel
  assert.strictEqual(f[4], '');    // no dispense
  await new Promise((resolve) => app.server.close(resolve));
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `node --test test/e2e.generic-fallback.test.js`
Expected: FAIL —— `Rule "generic-fallback" references unknown handler "generic"`（generic 未接线）

- [ ] **Step 3: 接线 server.js**

在 `server.js` 顶部，`const makeBalance = require('./src/handlers/balance');` 之后，加一行：

```js
const makeGeneric = require('./src/handlers/generic');
```

在 `createApp` 内构造 handlers 处，把：

```js
  const handlers = {
    goInService,
    withdrawal: makeWithdrawal(config.withdrawal || {}),
    balance: makeBalance(config.balance || {}),
  };
```

改为：

```js
  const handlers = {
    goInService,
    withdrawal: makeWithdrawal(config.withdrawal || {}),
    balance: makeBalance(config.balance || {}),
    generic: makeGeneric(config.generic || {}),
  };
```

- [ ] **Step 4: 运行端到端测试确认通过**

Run: `node --test test/e2e.generic-fallback.test.js`
Expected: PASS（2 tests）

- [ ] **Step 5: 迁移 config.json（加 generic 规则 + generic 块）**

在 `config.json` 的 `rules` 数组中，`balance-inquiry` 规则之后、`ready9-go-in-service` 规则之前，插入 generic-fallback 规则：

```json
    {
      "name": "balance-inquiry",
      "match": { "messageClass": "1", "subClass": "1", "field": { "index": 7, "startsWith": "C" } },
      "handler": "balance"
    },
    {
      "name": "generic-fallback",
      "match": { "messageClass": "1", "subClass": "1" },
      "handler": "generic"
    },
    {
      "name": "ready9-go-in-service",
```

并在顶层 `balance` 配置块之后（`}` 收尾后、文件末尾 `}` 之前），新增 `generic` 块：

```json
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
  },
  "generic": {
    "nextState": "048",
    "returnCard": "0",
    "printerFlag": "1",
    "includeCam": false,
    "camArc": "00",
    "receipt": {
      "screen": "",
      "printerData": "<GS>1  TRANSACTION CANCELLED<LF>  <DATE> <TIME><LF><FF>"
    }
  }
```

（即：在 `balance` 块的闭合 `}` 后加逗号，再追加 `generic` 块。next-state 048、screen/printer 模板均为种子/默认值，标注"需真 ATM 校准"。）

- [ ] **Step 6: 跑全部测试确认无回归**

Run: `node --test`
Expected: PASS（71 + 2 新 e2e = 73，全部通过）

- [ ] **Step 7: 更新 README.md**

在 `README.md` 的"余额查询与取款拒绝（子项目 2b）"小节之后、"录包"小节之前，插入：

````markdown
## A 族取款放宽与通用兜底（子项目 2c）

**A 族取款放宽**：取款规则从只匹配 `field[7] == "ADC     "` 放宽为 `field[7] startsWith "A"`，
覆盖整个取现族（`ADC`/`AAC`/`ABC` 等变体，同族不同账户类型）。真实抓包里约 450 笔取款因旧规则
写死 `ADC` 而漏匹配，放宽后消除。取款 handler 本身不变——A 族全部按**金额可兑现性 + `maxAmount`**
批准/拒绝。

> **已知模拟简化**：simulator 无真实余额，A 族一律按金额判定；真实主机对部分 A 族请求会因账户/
> 余额原因拒绝，而我们只按金额批准出钞。这是被接受的偏差。

**通用兜底**：任何未被取款(A)/余额(C)匹配的 class1-sub1 TxnRequest（改密 `D*`→698、`I*`、空 opcode
等）由 `generic` handler 应答一个安全的 class-4"取消/无法完成"reply：下一状态 `048`（可配）、
**不出钞**（fieldG 空）、退卡、不带 CAM。这保证**没有任何交易请求被晾着直到超时**。`config.json`
的 `generic` 块：

- **nextState**：兜底后 ATM 跳转状态（默认 `"048"`，复用取款拒绝的安全状态）。
- **returnCard** / **printerFlag** / **includeCam** / **camArc**：同取款/余额。
- **receipt.screen** / **receipt.printerData**：屏幕/凭条模板，支持 `<PAN> <DATE> <TIME> <RECNO> <LUNO>`
  与控制字 `<LF> <FF> <ESC> <SO> <SI> <GS>`。

**规则优先级**（engine 取首个匹配）：`withdrawal-request`(A) → `balance-inquiry`(C) →
`generic-fallback`(class1-sub1 兜底，必须最后)。generic 是 sub1，与 `unsolicited-status-no-reply`(sub2)
不冲突。

> **需真 ATM 校准**：通用兜底的 next-state `048` 与凭条模板为抓包种子；各交易族（转账/存款/改密/
> 对账单）的**专用**语义（专用 next-state、专用屏幕、改密确认等）属后续子项目，现统一落到兜底。
````

- [ ] **Step 8: 提交**

```bash
git add server.js config.json README.md test/e2e.generic-fallback.test.js
git commit -m "feat: wire generic fallback handler + rule with e2e tests"
```

---

## Self-Review 结果

**Spec 覆盖检查**（对照 `2026-07-06-a-family-and-generic-fallback-design.md`）：

- §3.1 A 族放宽（withdrawal-request equals→startsWith "A"，handler 不改）→ Task 1 ✅
- §3.2 通用兜底 handler（makeGeneric、不出钞、fieldG 空、048、永不 null、无 CAM）→ Task 2 ✅
- §3.3 规则顺序（withdrawal(A)→balance(C)→generic 兜底最后；不抢 A/C；sub2 不冲突）→ Task 1 matches 测试 + Task 3 config/e2e ✅
- §4 config（generic 块 + generic-fallback 规则）→ Task 3 ✅
- §5 数据流（A→withdrawal、C→balance、其它 class1sub1→generic）→ Task 3 e2e（AAC 批准 / D 族兜底）✅
- §6 错误处理（generic 永不 null；缺字段仍合法 reply）→ Task 2 单测（空 opcode/无金额）✅
- §7 测试策略（A 族变体、generic、规则顺序、e2e）→ Task 1/2/3 ✅
- §8 构建顺序（config 放宽 → generic.js → 装配）→ Task 1→3 一致 ✅

**决策落实**：A 族按金额判定（maxAmount 保持 null，handler 不改）✅；generic next-state 默认 048 ✅。

**占位符扫描**：无 TBD/TODO；每个改代码的步骤均给出完整代码或精确的单行 diff。

**类型一致性**：`makeGeneric(cfg)` 工厂签名、config 键（nextState/returnCard/printerFlag/includeCam/
camArc/receipt）在 Task 2/3 一致；消费的 `extractRequest(parsed)`、`applyReceipt/fmtDate/fmtTime/
buildCam`、`buildTransactionReply` 均为 2b 已存在导出，签名一致；空 fieldG + cam=null（7 字段）用法与
balance 一致。测试基线数目递增（63→66→71→73）自洽。

**已知取舍**：Task 1 Step 2 的"确认失败"较弱（matches 是纯函数，放宽断言可能直接通过）——已在步骤内
标注这些测试是回归护栏，真正的行为切换在 Step 3 改 config 后由全量 + e2e（Task 3）保证。
