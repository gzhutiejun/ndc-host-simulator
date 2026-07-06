# NDC Host Simulator 子项目 2c —— A 族取款放宽 + 通用兜底 设计文档

日期：2026-07-06
状态：已确认，待实现
依赖：子项目 1（模块化 simulator）、2a（取款）、2b（余额查询 + 取款拒绝），均已合并入 main

## 1. 背景与目标

2a/2b 让 simulator 能应答取款（批准/拒绝）与余额查询。但两处覆盖不全，暴露在真实抓包里：

1. **取款规则写死 `ADC     `**：`withdrawal-request` 规则只匹配 field[7] 精确等于 `"ADC     "`，
   而真实抓包里取现族除 `ADC` 外还有 `AAC`/`ABC` 等变体（同族不同账户类型），导致 **~450 笔取款
   落到 UNMATCHED**（无应答，真实 ATM 超时等待）。
2. **非 A/C 族的 TxnRequest 无人应答**：D 族（改密 → 698）、I 族、空 opcode 等交易请求不命中任何
   规则 → UNMATCHED → 真实 ATM 交易请求被晾着直到超时。

2c 的目标：**放宽取款匹配到整个 A 族**，并新增**通用兜底 handler**，保证**没有任何 TxnRequest
被晾着超时**——未被 withdrawal(A)/balance(C) 匹配的请求，一律回一个安全的"取消 / 无法完成"reply。

### 已确认的决策
- **范围**：A 族取款放宽 + 通用兜底。转账/存款等各交易族的**专用**处理仍不做。
- **A 族匹配**：`withdrawal-request` 规则 match 从 `field[7] equals "ADC     "` 改为
  `field[7] startsWith "A"`。engine 已支持 `startsWith`（2b 已用于 balance 的 `C`），零引擎改动。
- **A 族按金额判定（用户 2026-07-06 拍板：接受）**：A 族全部走 withdrawal handler，仅按
  **可兑现性 + `maxAmount`** 批准/拒绝。真实主机对部分 A 族请求会因账户/余额原因拒绝，而
  simulator 无真实余额，**只能按金额判定**——这会导致部分"真实主机会拒绝"的请求被我们批准出钞。
  这是已知且被接受的模拟简化。`maxAmount` 保持 `null`（不限），本子项目不新增限额。
- **通用兜底 next-state（用户拍板）**：`048`——复用 2b 取款拒绝用的同一安全状态，ATM 走已验证过
  的拒绝/取消流程；可配。
- **兜底行为**：class 4、fieldG **空（不出钞）**、不带 CAM、退卡。保证请求有明确应答而非超时。

### 非目标（留给以后）
- 转账/存款/改密/迷你对账单等各交易族的**专用**语义（专用 next-state、专用屏幕/凭条、改密确认等）。
  它们现在统一落到通用兜底的"无法完成"路径。
- 按 opcode 精确区分 A 族各变体的不同 next-state / 出钞逻辑。
- 真实余额、按账户类型区分批准逻辑、MAC、真实 EMV 密文。

## 2. 协议事实（来自真实抓包 AJMN1301）

请求 field[7]（8 字符操作码缓冲）首字符区分交易族：
- `A*`（`ADC`/`AAC`/`ABC` …）→ **取现族**，全是取款（不同账户类型），出钞，next-state `123`
  （拒绝 `048`/`038`/`050`）。→ 放宽后全部走现有 withdrawal handler，handler 本身**无需改动**。
- `C*`（`CC`/`CA` …）→ 查询族，不出钞，next-state `074` 等。→ 2b 已覆盖。
- 其它（`D*` 改密→698、`I*`、空 opcode 等）→ 各类交易请求，2c 之前无规则命中。→ 通用兜底。

关键分析：抓包里落到 UNMATCHED 的取款约 450 笔，全部因规则写死 `ADC` 而漏匹配；A 族放宽后消除。

## 3. 架构

复用 2a/2b 全部基础设施，**零引擎改动**。改动与新增：

```
config.json (mod)                 withdrawal-request 规则 equals→startsWith；新增 generic 块 + generic 规则
src/handlers/generic.js (new)     makeGeneric(cfg) 工厂
server.js (mod)                   装配 generic handler
README.md (mod)                   A 族放宽 + 通用兜底一节 + 校准说明
test/*                            generic 单测 + e2e（A 族变体命中取款 / 非 A-C 族命中兜底）
```

### 3.1 A 族放宽（仅 config.json）
`withdrawal-request` 规则：
```json
{ "name": "withdrawal-request",
  "match": { "messageClass": "1", "subClass": "1", "field": { "index": 7, "startsWith": "A" } },
  "handler": "withdrawal" }
```
handler、withdrawal 配置块均不动。回归：原 `ADC` 样本仍命中并批准。

### 3.2 通用兜底 handler（`src/handlers/generic.js`）
结构对标 balance handler（不出钞、fieldG 空、无 CAM），但**无余额金额**、next-state 默认 `048`。

- 导出 `makeGeneric(cfg)`；`cfg` 取自 `config.generic`。默认：
  `nextState='048'`、`returnCard='0'`、`printerFlag='1'`、`includeCam=false`、`camArc='00'`、
  `receipt={screen:'', printerData:''}`（默认不打凭条、不定屏，纯安全取消）。
- handler `(parsed, session, helpers)`：
  1. `extractRequest(parsed)` 取 `luno/mcn/panMasked`（金额忽略）。
  2. `values = { pan: panMasked, date, time, recno: String(session.nextTvn()), luno }`（沿用 nextTvn 记流水）。
  3. `screen = applyReceipt(receipt.screen, values)`；
     `printer = mcn + returnCard + printerFlag + applyReceipt(receipt.printerData, values)`；
     `cam = buildCam(camArc, includeCam)`（默认 null）。
  4. `buildTransactionReply({ luno, nextState, fieldG: '', screen, printer, cam })`。
  - **fieldG 空 → 不出钞**；`cam=null` → 不带 CAM。始终返回 reply（**绝不返回 null**），
    这是"没有 TxnRequest 被晾着"的关键。

### 3.3 规则顺序（engine 用 `rules.find` 取首个匹配，顺序即优先级）
class 1 / sub 1（TxnRequest）内，兜底**必须最后**：
```
withdrawal-request  (class1 sub1, field[7] startsWith "A")  → withdrawal
balance-inquiry     (class1 sub1, field[7] startsWith "C")  → balance
generic-fallback    (class1 sub1, 无 field 约束，兜底)       → generic   ← 新增，放在这两条之后
```
状态类规则（class2 的 ready9/ready-b/terminal、class1 sub2 的 unsolicited-status）不受影响，位置不变。
注意：`unsolicited-status-no-reply` 是 sub2，generic 是 sub1，两者不冲突。

## 4. 配置（config.json 新增/修改）

```json
{
  "rules": [
    { "name": "withdrawal-request", "match": { "messageClass": "1", "subClass": "1", "field": { "index": 7, "startsWith": "A" } }, "handler": "withdrawal" },
    { "name": "balance-inquiry",    "match": { "messageClass": "1", "subClass": "1", "field": { "index": 7, "startsWith": "C" } }, "handler": "balance" },
    { "name": "generic-fallback",   "match": { "messageClass": "1", "subClass": "1" }, "handler": "generic" }
    // …状态类规则不变…
  ],
  "generic": {
    "nextState": "048", "returnCard": "0", "printerFlag": "1",
    "includeCam": false, "camArc": "00",
    "receipt": { "screen": "", "printerData": "" }
  }
}
```
（next-state、screen/printer 模板均为种子/默认值，标注"需真 ATM 校准"。）

## 5. 数据流

```
请求 → framing 拆帧 → parse → session.remember → engine.respond：
  class1 sub1 & field[7] 以 'A' 开头 → withdrawal → approve(出钞) 或 decline(不出钞)
  class1 sub1 & field[7] 以 'C' 开头 → balance    → 074 + 余额（不出钞）
  class1 sub1 其它（D/I/空 等）       → generic     → 048 安全取消（不出钞，退卡）
  class2 / class1 sub2               → 状态规则（GIS / noReply）
→ server 加长度头回写
```
2c 之后，**任何 class1 sub1 TxnRequest 都有应答**，不再有取款 UNMATCHED。

## 6. 错误处理
- generic handler 对任意 class1 sub1 请求都能构造 reply（不依赖金额），**永不返回 null**。
- 请求缺 luno/mcn 等 → 沿用现有默认（`|| ''`），reply 仍合法。
- handler 抛异常 → server 的 per-frame try/catch 捕获，连接存活（继承 2a/2b 行为）。
- 仍可能 UNMATCHED 的：**非** class1 sub1 且不匹配任何状态规则的报文（正常应极少）——完整 hex 已录、告警。

## 7. 测试策略（Node 内置 node:test，零依赖）
- **A 族放宽（withdrawal / matches）**：
  - `AAC`、`ABC` 变体请求 → 命中 withdrawal，正常金额 → approve（出钞、next-state 123）。
  - 原 `ADC` 样本回归：仍 approve（不因放宽而改变）。
  - `C` 族请求**不**被 withdrawal 抢走（startsWith "A" 不匹配 "C"）——命中 balance。
- **generic handler**：
  - D 族 / 空 opcode 的 class1 sub1 请求 → class 4、next-state 048、fieldG 空、无 CAM、始终有 reply。
  - 缺字段的请求 → 仍返回合法 reply（不抛、不 null）。
  - `recno` 随 `session.nextTvn()` 递增（记流水）。
- **规则顺序（engine.matches / respond）**：A→withdrawal、C→balance、其它 class1sub1→generic；
  generic 不抢 A/C；unsolicited(sub2) 不被 generic 抢。
- **端到端**：
  - 发 `AAC` 取款帧 → 收到 approve reply（出钞）。
  - 发 D 族/空 opcode 帧 → 收到 048 兜底 reply（fieldG 空，不出钞），**不超时、不 UNMATCHED**。

## 8. 构建顺序
1. config.json：`withdrawal-request` equals→startsWith "A"（+ A 族回归/变体测试保绿）。
2. `src/handlers/generic.js`：`makeGeneric(cfg)` + 单测。
3. 装配 server.js（generic handler）+ config.json（generic 块 + generic-fallback 规则，置于 A/C 之后）。
4. e2e（A 族变体命中取款 / 非 A-C 族命中兜底）+ README（A 族放宽 + 通用兜底一节）。
