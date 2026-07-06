# I/D Family-Specific Next-State Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 给 I 交易族（→175）与 D 交易族（→698）各自专用的 next-state 应答，取代它们当前落到 generic 兜底的 048。

**Architecture:** 复用已由 `nextState` 参数化的 `generic` handler——在 `server.js` 再实例化两个（`familyD` nextState 698、`familyI` nextState 175），在 `config.json` 新增两条规则（`d-family-reply`、`i-family-reply`，均置于 `generic-fallback` catch-all 之前），零新 handler 代码。engine 及所有 handler 源码不改。

**Tech Stack:** Node.js（CommonJS）、内置 `node:test` + `node:assert`（零第三方依赖）。

## Global Constraints

- 语言/运行时：Node.js，CommonJS（`require`/`module.exports`）。
- 测试框架：仅 Node 内置 `node:test` + `node:assert`，禁止第三方依赖。
- 运行测试：`node --test`（全量）或 `node --test test/<file>`（单文件）。
- 不改动 `src/engine.js`、`src/handlers/*`（复用现有 `makeGeneric`，不新写 handler）。
- next-state 值来自抓包实测、100% 一致：**I→`175`、D→`698`**。使用这些精确字符串。
- 规则匹配：D 族 `field[7] startsWith "D"`、I 族 `field[7] startsWith "I"`，均 `messageClass "1"` / `subClass "1"`。
- **规则顺序硬约束**：`d-family-reply` 与 `i-family-reply` 必须都排在 `generic-fallback` 之前（generic 无 field 约束、否则先抢）。
- 命名中性：handler 实例 `familyD`/`familyI`，规则 `d-family-reply`/`i-family-reply`；"D=改密"只作 README 注释，不写进代码。
- 提交信息用 `feat:` / `test:` / `docs:` 前缀。

---

### Task 1: I/D family-specific next-state（server 装配 + config 规则 + e2e + config 完整性 + README）

这是一个内聚的小改动：一条端到端能力（D→698、I→175），故作为单任务、e2e-first TDD。

**Files:**
- Modify: `server.js:18-23`（`createApp` 的 `handlers` 表，+2 个 `makeGeneric` 实例）
- Modify: `config.json`（rules 内 `balance-inquiry` 与 `generic-fallback` 之间插入 2 条规则；顶层新增 `familyD`/`familyI` 两块）
- Modify: `test/e2e.generic-fallback.test.js`（`makeApp` 的 rules/config 加 D/I；文件末尾加 3 个 e2e）
- Create: `test/config.test.js`（守护 prod config.json 的规则顺序与 next-state）
- Modify: `README.md`（新增 "I / D 交易族专用 next-state（子项目 2e）" 一节）

**Interfaces:**
- Consumes:
  - `makeGeneric(cfg)` from `src/handlers/generic.js` —— `(parsed, session, helpers) => reply|never-null`；已由 `cfg.nextState` 参数化（默认 048）；其余 `returnCard`/`printerFlag`/`includeCam`/`camArc`/`receipt` 同 generic 默认。
  - `createApp(config)` from `server.js` —— 从 `config.familyD`/`config.familyI` 读块构造对应 handler；从 `config.rules` 装配引擎。
  - e2e 测试文件已有的 `sendFrame(port, payload)` 与 `makeApp()` 辅助函数、`FS` 导入。
- Produces: 无（终端能力）。规则→handler 名约定：`d-family-reply`→`familyD`、`i-family-reply`→`familyI`。

**Note on unit tests:** `generic` handler 的 `nextState` 参数化已由 `test/generic.test.js:42`（`generic fallback: nextState is configurable`，用 '138'）覆盖；不再新增 698/175 的 handler 单测（近乎逐字重复）。2e 的真实覆盖是 e2e 装配 + config.json 完整性测试。

- [ ] **Step 1: 写失败的 e2e（先扩 `makeApp`，再在文件末尾加 3 个测试）**

先把 `test/e2e.generic-fallback.test.js` 的 `makeApp()` 里 `rules` 数组在 `generic-fallback` 条目**之前**插入两条，并在 `createApp({...})` 配置对象里 `generic: {...}` 旁加两块 `familyD`/`familyI`。插入后的 `makeApp` 应为：

```javascript
function makeApp() {
  const capDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ndc-gen-'));
  return createApp({
    enableTLS: false, responseDelayMs: 0, captureDir: capDir,
    rules: [
      { name: 'withdrawal-request', match: { messageClass: '1', subClass: '1', field: { index: 7, startsWith: 'A' } }, handler: 'withdrawal' },
      { name: 'balance-inquiry', match: { messageClass: '1', subClass: '1', field: { index: 7, startsWith: 'C' } }, handler: 'balance' },
      { name: 'd-family-reply', match: { messageClass: '1', subClass: '1', field: { index: 7, startsWith: 'D' } }, handler: 'familyD' },
      { name: 'i-family-reply', match: { messageClass: '1', subClass: '1', field: { index: 7, startsWith: 'I' } }, handler: 'familyI' },
      { name: 'generic-fallback', match: { messageClass: '1', subClass: '1' }, handler: 'generic' },
    ],
    withdrawal: { cassettes: [50, 100, 500, 1000], approvedNextState: '123' },
    balance: { nextState: '074', amount: '5000.00', receipt: { screen: 'BAL <BALANCE>', printerData: '' } },
    familyD: { nextState: '698', receipt: { screen: '', printerData: '' } },
    familyI: { nextState: '175', receipt: { screen: '', printerData: '' } },
    generic: { nextState: '048', receipt: { screen: '', printerData: '' } },
  });
}
```

然后在文件末尾追加 3 个测试：

```javascript
test('D-family class1-sub1 request gets a 698 family-specific reply (no dispense)', { timeout: 5000 }, async () => {
  const app = makeApp();
  await new Promise((resolve) => app.server.listen(0, resolve));
  const reply = await sendFrame(app.server.address().port, ['11', '000', '', '', '15', ';X=X?', '', 'D       ', ''].join(FS));
  const f = reply.split(FS);
  assert.strictEqual(f[0], '4');   // TransactionReply
  assert.strictEqual(f[3], '698'); // D-family observed next-state (was 048 under generic)
  assert.strictEqual(f[4], '');    // no dispense
  await new Promise((resolve) => app.server.close(resolve));
});

test('I-family class1-sub1 request gets a 175 family-specific reply (no dispense)', { timeout: 5000 }, async () => {
  const app = makeApp();
  await new Promise((resolve) => app.server.listen(0, resolve));
  const reply = await sendFrame(app.server.address().port, ['11', '000', '', '', '15', ';X=X?', '', 'I       ', ''].join(FS));
  const f = reply.split(FS);
  assert.strictEqual(f[0], '4');
  assert.strictEqual(f[3], '175'); // I-family observed next-state
  assert.strictEqual(f[4], '');
  await new Promise((resolve) => app.server.close(resolve));
});

test('non A/C/D/I class1-sub1 request still gets the 048 generic fallback', { timeout: 5000 }, async () => {
  const app = makeApp();
  await new Promise((resolve) => app.server.listen(0, resolve));
  const reply = await sendFrame(app.server.address().port, ['11', '000', '', '', '15', ';X=X?', '', 'Z       ', ''].join(FS));
  const f = reply.split(FS);
  assert.strictEqual(f[0], '4');
  assert.strictEqual(f[3], '048'); // unchanged: still safe generic cancel
  assert.strictEqual(f[4], '');
  await new Promise((resolve) => app.server.close(resolve));
});
```

- [ ] **Step 2: 运行 e2e，确认 D/I 失败**

Run: `node --test test/e2e.generic-fallback.test.js`
Expected: `D-family...698` 与 `I-family...175` 两个新测试 FAIL——`makeApp` 的规则引用了 `familyD`/`familyI` handler，但 `server.js` 尚未构造它们，`engine.respond` 抛 `references unknown handler "familyD"`，被 server per-frame try/catch 吞掉、无 SEND，`sendFrame` 因连接关闭 reject（`closed with no frame`）。`non A/C/D/I...048` 测试应 PASS（'Z' 不匹配 D/I，落 generic）。

- [ ] **Step 3: 实现 server.js handler 装配**

把 `server.js:18-23` 的 `handlers` 对象替换为（在 `balance` 与 `generic` 之间加 `familyD`/`familyI`）：

```javascript
  const handlers = {
    goInService,
    withdrawal: makeWithdrawal(config.withdrawal || {}),
    balance: makeBalance(config.balance || {}),
    familyD: makeGeneric(config.familyD || { nextState: '698' }),
    familyI: makeGeneric(config.familyI || { nextState: '175' }),
    generic: makeGeneric(config.generic || {}),
  };
```

（`config.familyD || { nextState: '698' }` 的缺省对象仅在整块缺失时生效；makeGeneric 内部对 `receipt`/`returnCard` 等再补自身默认。makeGeneric 已在 `server.js:13` 导入，无需新 require。）

- [ ] **Step 4: 运行 e2e，确认全绿**

Run: `node --test test/e2e.generic-fallback.test.js`
Expected: 全部 PASS，含新的 D→698 / I→175 / Z→048 三条，及既有的 A 族/空金额落 generic 等测试。

- [ ] **Step 5: 更新 prod config.json（规则 + 两块）**

在 `config.json` 的 `rules` 数组里，`balance-inquiry` 条目（结束于 `"handler": "balance" }`）之后、`generic-fallback` 条目之前，插入两条规则：

```json
    {
      "name": "d-family-reply",
      "match": { "messageClass": "1", "subClass": "1", "field": { "index": 7, "startsWith": "D" } },
      "handler": "familyD"
    },
    {
      "name": "i-family-reply",
      "match": { "messageClass": "1", "subClass": "1", "field": { "index": 7, "startsWith": "I" } },
      "handler": "familyI"
    },
```

并在顶层 `generic` 块（结束于其 `}`）之后插入两块（注意在 `generic` 块的 `}` 后补逗号）：

```json
  "familyD": {
    "nextState": "698",
    "returnCard": "0",
    "printerFlag": "1",
    "includeCam": false,
    "camArc": "00",
    "receipt": { "screen": "", "printerData": "<GS>1  PIN CHANGE<LF>  <DATE> <TIME><LF><FF>" }
  },
  "familyI": {
    "nextState": "175",
    "returnCard": "0",
    "printerFlag": "1",
    "includeCam": false,
    "camArc": "00",
    "receipt": { "screen": "", "printerData": "<GS>1  TRANSACTION<LF>  <DATE> <TIME><LF><FF>" }
  }
```

（next-state 698/175 为抓包实测；printerData 为 seed，标注需真 ATM 校准；screen 留空。）

- [ ] **Step 6: 写 config.json 完整性测试**

创建 `test/config.test.js`（守护 prod 配置——e2e 用内联 config，config.json 本身此前无规则级测试）：

```javascript
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const cfg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'config.json'), 'utf8'));

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
```

- [ ] **Step 7: 运行全量测试，确认通过**

Run: `node --test`
Expected: 全部 PASS，含新增 3 个 e2e + 2 个 config 完整性测试，零回归。

- [ ] **Step 8: 更新 README**

在 `README.md` 的 "A 族取款放宽与通用兜底（子项目 2c）" 一节之后（或紧邻兜底说明处），新增：

```markdown
## I / D 交易族专用 next-state（子项目 2e）

抓包（AJMN1301，9263 条 request→紧邻 reply 配对）实测：请求 `field[7]` 首字符分族后，除已覆盖的
A（取款）/C（查询）外，仅 **I 族**与 **D 族**有干净、100% 一致的单一应答 next-state：

- **I 族（15/15）→ next-state `175`**
- **D 族（2/2）→ next-state `698`**（疑似改密确认；代码不硬断言语义）

故这两族不再落通用兜底的 048，而由各自专用应答处理：复用 `generic` handler（已由 `nextState`
参数化）再实例化 `familyI`（175）、`familyD`（698）两个实例，行为同兜底——class-4、fieldG 空
（不出钞）、退卡、无 CAM、永不返回 null——仅 next-state 不同。规则顺序：

```
withdrawal-request (A) → balance-inquiry (C) → d-family-reply (D,698) → i-family-reply (I,175) → generic-fallback (048, 兜底最后)
```

> C 族子类型（`074/151/077/471`…）随真实账户状态分流（同一 opcode 既→074 又→151），无真实余额/
> 账户状态无法确定性复现，未纳入；A 族各拒绝态同理。`familyD`/`familyI` 的 next-state 为抓包实测，
> screen/printer 模板为 seed，**需真 ATM 校准**。
```

- [ ] **Step 9: 提交**

```bash
git add server.js config.json test/e2e.generic-fallback.test.js test/config.test.js README.md
git commit -m "feat: give I-family (175) and D-family (698) their own next-state replies"
```

---

## Self-Review

**Spec coverage：**
- §1/§2 机制（复用 makeGeneric 两实例、零新 handler）→ Step 3（server.js）。
- §2.2 规则顺序（D/I 在 generic 之前）→ Step 1（e2e makeApp）+ Step 5（config.json）+ Step 6（config 完整性断言 d<g、i<g）。
- §2.3 config 块（familyD 698 / familyI 175）→ Step 5 + Step 6 断言。
- §3 数据流（D→698、I→175、其它→048）→ Step 1 三个 e2e。
- §5 测试：单元参数化——已有 `generic.test.js:42` 覆盖，Note 说明不重复；e2e D/I/非族 → Step 1；额外 config 完整性 → Step 6（改进 spec，守护 prod config）。
- §4 错误处理（familyD/I 永不返回 null、异常被 server 捕获）→ 继承 generic，未改其源码。
- 命名中性（familyD/familyI、d/i-family-reply，D=改密仅 README）→ Step 3/5/8 一致。

**Placeholder scan：** 无 TBD/TODO；所有代码步骤含完整代码；README、config 均给确切文本与插入位置。

**Type consistency：** 规则名 `d-family-reply`/`i-family-reply` 与 handler 名 `familyD`/`familyI` 在 Step 1（e2e）、Step 3（server）、Step 5（config）、Step 6（config 测试）四处完全一致；next-state 字符串 `'698'`/`'175'`/`'048'` 各处一致；`field.startsWith` `'D'`/`'I'` 一致。
