# Handler-Null Fall-Through Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 engine 的 `respond` 在 handler 返回 `null` 时落到下一条匹配规则，使 A 族缺失/非数字金额的取款请求自然落到 `generic-fallback` 得到安全应答，而非静默超时。

**Architecture:** 唯一核心改动在 `src/engine.js`：`respond` 从 `rules.find`（首个匹配即锁定）改为按顺序遍历所有规则；`noReply`/`template` 规则优先终止，`handler` 返回非 null 终止、返回 null 则视作"本规则不适用"继续下一条。`server.js`、`config.json`、所有 handler 均不改。

**Tech Stack:** Node.js（CommonJS）、内置 `node:test` + `node:assert`（零第三方依赖）。

## Global Constraints

- 语言/运行时：Node.js，CommonJS（`require`/`module.exports`），与现有代码一致。
- 测试框架：仅 Node 内置 `node:test` + `node:assert`，禁止引入第三方依赖。
- 运行测试：`node --test`（全量）或 `node --test test/<file>`（单文件）。
- 不改动 `server.js`、`config.json`、`src/handlers/*`。
- `respond` 返回结构保持 `{ payload, rule }` 不变；UNMATCHED 仍为 `{ payload: null, rule: null }`。
- 保留既有语义正交性：规则级 `noReply: true` 是刻意的"正常无应答"，必须优先终止，绝不落到后续规则。
- 提交信息用 `feat:` / `test:` / `docs:` 前缀，与仓库历史一致。

---

### Task 1: engine `respond` handler-null fall-through（核心 + 单元测试）

**Files:**
- Modify: `src/engine.js:28-49`（`createEngine` 内 `respond`）
- Test: `test/engine.test.js`（新增 4 个用例，既有用例保持不变）

**Interfaces:**
- Consumes: 无（本任务是叶子改动）。沿用现有 `matches(match, parsed)`、模块内 `applyTemplate`、`constants`。
- Produces（后续 e2e 任务依赖的行为契约）：
  - `engine.respond(parsed, session) -> { payload, rule }`
  - handler 返回 `null` → 继续下一条**匹配**规则；handler 返回非 `null` → `{ payload, rule: <该规则名> }` 并终止。
  - `noReply === true` 规则 → `{ payload: null, rule: <规则名> }` 并终止（不落到后续规则）。
  - `template != null` 规则 → `{ payload: <模板串>, rule: <规则名> }` 并终止。
  - 无任何规则匹配 → `{ payload: null, rule: null }`。
  - 有匹配但全部 handler 返回 null → `{ payload: null, rule: <最后一条匹配规则名> }`。

- [ ] **Step 1: 写失败测试（新增 4 个用例，追加到 `test/engine.test.js` 末尾）**

```javascript
test('respond falls through to the next rule when a handler returns null', () => {
  const engine = createEngine({
    rules: [
      { name: 'a', match: { messageClass: '2' }, handler: 'nullH' },
      { name: 'b', match: { messageClass: '2' }, handler: 'okH' },
    ],
    handlers: { nullH: () => null, okH: () => 'REPLY' },
  });
  const p = parse(encodeText('22' + FS + '000'));
  const out = engine.respond(p, createSession());
  assert.strictEqual(out.payload, 'REPLY');
  assert.strictEqual(out.rule, 'b');
});

test('respond returns null payload with the last matched rule name when every handler returns null', () => {
  const engine = createEngine({
    rules: [
      { name: 'a', match: { messageClass: '2' }, handler: 'nullH' },
      { name: 'b', match: { messageClass: '2' }, handler: 'nullH' },
    ],
    handlers: { nullH: () => null },
  });
  const p = parse(encodeText('22' + FS + '000'));
  const out = engine.respond(p, createSession());
  assert.strictEqual(out.payload, null);
  assert.strictEqual(out.rule, 'b');
});

test('respond stops at a noReply rule and does not fall through to later rules', () => {
  let reached = false;
  const engine = createEngine({
    rules: [
      { name: 'silent', match: { messageClass: '2' }, noReply: true },
      { name: 'after', match: { messageClass: '2' }, handler: 'mark' },
    ],
    handlers: { mark: () => { reached = true; return 'X'; } },
  });
  const p = parse(encodeText('22' + FS + '000'));
  const out = engine.respond(p, createSession());
  assert.strictEqual(out.payload, null);
  assert.strictEqual(out.rule, 'silent');
  assert.strictEqual(reached, false);
});

test('respond stops at the first handler that returns a payload (later rules untouched)', () => {
  let reached = false;
  const engine = createEngine({
    rules: [
      { name: 'first', match: { messageClass: '2' }, handler: 'okH' },
      { name: 'second', match: { messageClass: '2' }, handler: 'mark' },
    ],
    handlers: { okH: () => 'FIRST', mark: () => { reached = true; return 'SECOND'; } },
  });
  const p = parse(encodeText('22' + FS + '000'));
  const out = engine.respond(p, createSession());
  assert.strictEqual(out.payload, 'FIRST');
  assert.strictEqual(out.rule, 'first');
  assert.strictEqual(reached, false);
});
```

- [ ] **Step 2: 运行新测试，确认失败**

Run: `node --test test/engine.test.js`
Expected: 新增的 `falls through` / `last matched rule name` 用例 FAIL（当前 `rules.find` 首个匹配即锁定，handler 返回 null 会得到 `{ payload: null, rule: 'a' }`，而非落到下一条）。`noReply` / `first handler wins` 两个用例在旧实现下也应通过（回归基线），确认它们目前 PASS。

- [ ] **Step 3: 实现 fall-through（替换 `src/engine.js` 的 `createEngine`）**

把 `src/engine.js:28-49` 的 `createEngine` 整体替换为：

```javascript
function createEngine({ rules = [], handlers = {}, now = () => new Date() } = {}) {
  return {
    respond(parsed, session) {
      const ctx = {
        luno: (session && session.luno) || parsed.luno || '',
        tvn: session ? String(session.tvn) : '0',
      };
      let lastRule = null;
      for (const rule of rules) {
        if (!matches(rule.match, parsed)) continue;
        lastRule = rule.name;
        if (rule.noReply === true) return { payload: null, rule: rule.name };
        if (rule.handler != null) {
          const fn = handlers[rule.handler];
          if (typeof fn !== 'function') {
            throw new Error(`Rule "${rule.name}" references unknown handler "${rule.handler}"`);
          }
          const payload = fn(parsed, session, { applyTemplate, ctx, constants, now });
          if (payload != null) return { payload, rule: rule.name };
          continue; // handler 返回 null：本规则不适用，试下一条匹配规则
        }
        if (rule.template != null) return { payload: applyTemplate(rule.template, ctx), rule: rule.name };
        throw new Error(`Rule "${rule.name}" matched but defines no template, handler, or noReply`);
      }
      return { payload: null, rule: lastRule };
    },
  };
}
```

要点：`ctx` 只依赖 `parsed`/`session`、不依赖 rule，移到循环外构造一次，语义与原先等价。`throw`（未知 handler / 既无 template 也无 handler/noReply）逻辑保持不变。

- [ ] **Step 4: 运行全量测试，确认通过**

Run: `node --test`
Expected: 全部 PASS，包括本任务新增 4 个用例，以及既有的 `respond picks first matching template rule` / `respond honours noReply rule` / `respond returns null rule when no rule matches` / `respond throws for a matched rule with no template, handler, or noReply` 等回归用例。

- [ ] **Step 5: 提交**

```bash
git add src/engine.js test/engine.test.js
git commit -m "feat: fall through to the next rule when a handler returns null"
```

---

### Task 2: e2e 回归证明 + README 更新

**Files:**
- Test: `test/e2e.generic-fallback.test.js`（新增 1 个用例）
- Modify: `README.md`（把 2c 记录的"已知边界"更新为"已闭合"）

**Interfaces:**
- Consumes: Task 1 的行为契约——A 族请求金额字段为空时 `withdrawal` handler 返回 null，engine 落到 `generic-fallback`。复用该测试文件已有的 `sendFrame(port, payload)`、`makeApp()`（其 `rules` 已含 `withdrawal(A) → balance(C) → generic-fallback`）、`FS` 导入。
- Produces: 无（终端任务）。

- [ ] **Step 1: 写失败测试（追加到 `test/e2e.generic-fallback.test.js` 末尾）**

```javascript
test('A-family withdrawal with an empty amount falls through to the 048 generic fallback (no timeout)', { timeout: 5000 }, async () => {
  const app = makeApp();
  await new Promise((resolve) => app.server.listen(0, resolve));
  // field[7]='A       ' 命中 withdrawal 规则，但 field[8] 金额为空 → withdrawal handler 返回 null
  const reply = await sendFrame(app.server.address().port, ['11', '000', '', '', '15', ';X=X?', '', 'A       ', ''].join(FS));
  const f = reply.split(FS);
  assert.strictEqual(f[0], '4');   // TransactionReply
  assert.strictEqual(f[3], '048'); // generic 安全取消，而非无应答超时
  assert.strictEqual(f[4], '');    // fieldG 空，不出钞
  await new Promise((resolve) => app.server.close(resolve));
});
```

- [ ] **Step 2: 运行该测试，确认失败**

Run: `node --test test/e2e.generic-fallback.test.js`
Expected: 新用例在 Task 1 已合入的情况下应通过；若临时回退 Task 1 则 FAIL——`sendFrame` 因 withdrawal 返回 null、server 静默无应答，5s 后连接被关闭触发 `closed with no frame` reject。（本步用于确认测试确实在检验 fall-through 行为；正常顺序下 Task 1 已完成，故预期 PASS。）

- [ ] **Step 3: 更新 README 的边界记录**

`README.md:115-120` 现有一段 block quote（2c 记录的已知边界），原文为：

```markdown
> **已知边界（兜底覆盖不到的一处）**：兜底只接住"未匹配任何 handler 规则"的请求。若一个 A 族取款
> 请求**缺失/非数字金额**，它已先命中 `withdrawal-request` 规则、由取款 handler 返回 `null`——引擎按
> 首个匹配已锁定该规则、不会再落到 `generic-fallback`，server 把"规则命中但 payload 为 null"当作
> noReply，故此请求仍无应答会超时。放宽到 A 族后此边界从仅 `ADC` 扩到整个 `A*`（概率仍极低：正常
> NDC 取款必带金额）。修复需改取款 handler（对不可解析金额回 decline）或让 handler 的 null 结果落到
> 下一条规则——均超出 2c 范围，留作后续。
```

整段替换为（改用相同 block quote 风格标注"已闭合"）：

```markdown
> **已闭合（子项目 2d）**：A 族取款请求**缺失/非数字金额**时，`withdrawal` handler 返回 `null`，
> 引擎现会**落到下一条匹配规则**（不再"首个匹配即锁定"），最终由 `generic-fallback` 回一个安全的
> 048 取消应答，不再静默超时。残余边界仅在**移除 `generic-fallback` 兜底规则**时存在——此时全部
> handler 返回 `null` 的 class1-sub1 请求会静默无应答。**要保证任何 TxnRequest 必有应答，须保留
> class1-sub1 的兜底规则。**
```

- [ ] **Step 4: 运行全量测试，确认通过**

Run: `node --test`
Expected: 全部 PASS。

- [ ] **Step 5: 提交**

```bash
git add test/e2e.generic-fallback.test.js README.md
git commit -m "test: prove A-family empty-amount falls through to generic; docs: mark boundary closed"
```

---

## Self-Review

**Spec coverage：**
- §3.1 `respond` 新逻辑（noReply/template 终止、handler-null fall-through、全 null 返回 lastRule、无匹配返回 null）→ Task 1 Step 3 全覆盖。
- §7 单元测试（fall-through / 全 null / noReply 终止 / template 终止 / 首个非 null 胜出 / 无匹配）→ Task 1 新增 4 用例 + 既有 `template`/`no rule matches` 回归用例覆盖。
- §7 e2e（A 族空金额落 generic 048）→ Task 2 Step 1。
- §6 / §3.2 边界记录更新（闭合 + 残余仅无兜底时）→ Task 2 Step 3。
- §5 错误处理（未知 handler throw、异常不触发 fall-through）→ Task 1 保留 `throw`；`payload = fn(...)` 抛异常时未被 catch，直接向上抛（不进入 `continue` 分支），符合"异常不当作不适用"。

**Placeholder scan：** 无 TBD/TODO；所有代码步骤含完整代码；README 步骤给了确切改写文本与定位说明。

**Type consistency：** `respond` 返回 `{ payload, rule }` 贯穿两任务一致；`matches`/`applyTemplate`/`constants`/`now` 名称与 `src/engine.js` 现有一致；e2e 复用文件内既有 `sendFrame`/`makeApp`/`FS`，无新符号。
