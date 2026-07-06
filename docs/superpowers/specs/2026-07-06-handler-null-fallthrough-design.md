# NDC Host Simulator 子项目 2d —— handler-null 落到下一条规则 设计文档

日期：2026-07-06
状态：已确认，待实现
依赖：子项目 1（模块化 simulator）、2a（取款）、2b（余额查询 + 取款拒绝）、2c（A 族放宽 + 通用兜底），均已合并入 main

## 1. 背景与目标

2c 把取款匹配从写死 `ADC` 放宽到整个 A 族（`field[7] startsWith "A"`），并新增 `generic-fallback`
兜底，保证任何 class1 sub1 TxnRequest 都有应答。但 2c 终审留下一个**已知残余边界**（已记入 README）：

> A 族取款请求若**缺失 / 非数字金额**，会先命中 `withdrawal-request` 规则 → `withdrawal` handler
> 第 21 行 `if (req.amount == null) return null` → `engine.respond` 用 `rules.find` **首个匹配即锁定**，
> 返回 `{ payload: null, rule: 'withdrawal-request' }` → `server.js` 见 `payload == null` 但
> `rule != null`，当作 noReply → `continue`，**不应答** → 真实 ATM 超时等待。

放宽到整个 A 族后，此边界从"仅 ADC"扩到"整个 A\*"（概率仍极低，正常取款必带金额，但保证不完整）。

2d 的目标：**让 handler 返回 null 语义化为"本规则不适用，试下一条规则"**，使这类请求自然落到
`generic-fallback` 产出安全应答，从而**闭合"有兜底就必有应答"这一可验证不变量**。

### 已确认的决策
- **实现路径（用户 2026-07-06 拍板：方案 B）**：改 engine，让 handler-null 落到下一条匹配规则；
  **不**在 withdrawal handler 里自造 decline（方案 A 被否——语义弱、与 generic 逻辑重复）。
- **noReply 终止**：规则级 `noReply: true` 是刻意的"正常无应答"（心跳/终端态），遍历时**优先终止**，
  绝不落到 generic。
- **template 终止**：`template` 规则总产出 payload，终止。
- **全 handler-null 且无兜底**：返回 `{ payload: null, rule: <最后一条匹配规则名> }`，server 照旧当
  noReply 静默——仅在**没有 catch-all** 时可达；线上有 `generic-fallback`，此路不可达（见 §6）。

### 非目标（留给以后）
- 各交易族（转账/存款/改密→698 等）的**专用**应答语义——仍统一走 generic 的"无法完成"。
- withdrawal handler 对不可解析金额产出**专用** decline 屏幕/凭条。
- 改动 server.js / config.json / 任何 handler。

## 2. 现状事实（读码确认）

- `engine.respond`（`src/engine.js:30`）用 `rules.find(...)`，**首个匹配即锁定**，不再看后续规则。
- handler 返回 null **目前仅 `withdrawal`** 产生（`amount == null` guard，`src/handlers/withdrawal.js:21`）；
  `balance` / `generic` / `goInService` 从不返回 null。
- 真正的"正常无应答"是**规则级 `noReply: true`**（心跳 ready-b、终端态、unsolicited-status），
  与 handler-null 语义**正交**。
- `withdrawal` 在 `return null` **之前不消费任何 session 状态**（`session.nextTvn()` 在 guard 之后），
  故落到 generic 只消费一个流水号，**无双消费**。
- 线上 `config.json` 规则顺序已是 `withdrawal(A) → balance(C) → generic-fallback(class1 sub1 兜底)`，
  fall-through 天然能落到 generic。

## 3. 架构

**零 server / config / handler 改动。** 唯一核心改动在 `src/engine.js`。

```
src/engine.js (mod)          respond: rules.find → 顺序遍历 + handler-null fall-through
test/engine.test.js (mod)    fall-through / 全 null / noReply·template 终止 / 首个非 null 胜出（回归）
test/e2e.generic-fallback.test.js (mod)  A 族空金额请求 → 落到 generic 048 应答（不再超时）
README.md (mod)              把 2c 记的"已知边界"更新为"已闭合"
```

### 3.1 `respond` 新逻辑

当前：
```js
respond(parsed, session) {
  const rule = rules.find((r) => matches(r.match, parsed));
  if (!rule) return { payload: null, rule: null };
  if (rule.noReply === true) return { payload: null, rule: rule.name };
  // build ctx …
  if (rule.handler != null) return { payload: fn(...), rule: rule.name };
  if (rule.template != null) return { payload: applyTemplate(...), rule: rule.name };
  throw new Error(...);
}
```

改为**按顺序遍历所有规则**，对每条 `matches()` 为真的规则：
- `noReply === true` → `return { payload: null, rule: name }`（**终止**）
- `template != null` → `return { payload: applyTemplate(template, ctx), rule: name }`（**终止**）
- `handler != null` → 取 `fn`；`fn` 非函数 → `throw`（不变）；`payload = fn(parsed, session, {...})`；
  - `payload != null` → `return { payload, rule: name }`（**终止**）
  - `payload == null` → 记住 `lastRule = name`，**继续下一条匹配规则**
- 三者皆无 → `throw new Error('Rule "..." matched but defines no template, handler, or noReply')`（不变）

遍历结束仍无终止：
- 若从未有任何规则匹配 → `return { payload: null, rule: null }`（UNMATCHED，不变）
- 若有匹配但全部 handler 返回 null → `return { payload: null, rule: lastRule }`

`ctx` 与 `applyTemplate/constants/now` 传参保持不变（`ctx` 在循环外构造一次即可，语义等价）。

### 3.2 与 server.js 的契合（不改 server）

- fall-through 命中 generic → `payload` 非 null → server 正常 SEND。
- 无兜底时全 null → `{ payload: null, rule: lastRule }` → server `rule != null` 且 `payload == null`
  → 走既有 noReply 分支静默（现状边界，仅无兜底时可达）。
- 无任何匹配 → `{ payload: null, rule: null }` → server 大声告警 UNMATCHED（不变）。

## 4. 数据流（A 族空金额请求，2d 之后）

```
请求(class1 sub1, field[7]='A       ', 金额字段空) → parse → session.remember → engine.respond：
  withdrawal-request 匹配(startsWith "A") → withdrawal handler → amount==null → return null → 继续
  balance-inquiry    不匹配(startsWith "C")                                              → 跳过
  generic-fallback   匹配(class1 sub1)     → generic handler → 048 安全取消(fieldG 空,退卡) → 终止
→ server 加长度头回写 048 应答（不再超时、不再静默 noReply）
```

## 5. 错误处理
- handler 抛异常 → server per-frame try/catch 捕获，连接存活（不变）。engine 内不新增吞异常逻辑。
- `handler` 引用未知名 → 遍历到该规则时仍 `throw`（不变）。
- fall-through 只在 handler **返回值为 null** 时发生；handler **抛异常**不触发 fall-through（异常照旧向上抛，
  由 server 捕获）——避免把"handler 出 bug"误当"不适用"。

## 6. 已知残余边界（更新记录）
- 2c 记的"A 族空金额 → 无应答超时"边界，2d 后在**线上配置（含 generic-fallback）下闭合**。
- 唯一残余：**移除 generic-fallback 兜底**时，全 handler-null 的请求仍静默 noReply。属配置选择，
  README 明确标注"要保证必有应答，须保留 class1 sub1 兜底规则"。

## 7. 测试策略（Node 内置 node:test，零依赖）

- **`test/engine.test.js`（单元）**：
  - handler 返回 null → 落到下一条 handler 非 null 的规则；`payload` 为后者，`rule` 名为后者。
  - 两条匹配规则 handler 均返回 null 且无兜底 → `{ payload: null, rule: 第二条(最后匹配)规则名 }`。
  - 首个匹配是 `noReply` → 立即 `{ payload: null, rule: name }`，**不**落到其后规则（回归）。
  - 首个匹配是 `template` → 立即返回模板 payload（回归）。
  - 首个匹配 handler 非 null → 首个胜出，后续规则不执行（回归；可用带副作用的桩 handler 断言未被调用）。
  - 无任何规则匹配 → `{ payload: null, rule: null }`（回归）。
- **`test/e2e.generic-fallback.test.js`（e2e，回归证明）**：
  - 发 A 族帧、金额字段为空（如 `['11','000','','','15',';X=X?','','A       ',''].join(FS)`）→
    收到 class 4、next-state `048`、`fieldG` 空（不出钞）的 generic 应答，**不超时**。
  - （对照：改前此帧 withdrawal 返回 null → 静默无应答；测试以"能收到帧"证明闭合。）

## 8. 构建顺序
1. `src/engine.js`：`respond` 改遍历 + handler-null fall-through；先补/改 `test/engine.test.js` 单测（TDD）。
2. `test/e2e.generic-fallback.test.js`：新增 A 族空金额落 generic 的 e2e。
3. README：把"已知边界"更新为"已闭合（线上兜底下）+ 残余仅无兜底时"。
