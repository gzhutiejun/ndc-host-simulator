# NDC Host Simulator 子项目 2e —— I / D 交易族专用 next-state 设计文档

日期：2026-07-06
状态：已确认，待实现
依赖：子项目 1（模块化 simulator）、2a（取款）、2b（余额查询 + 取款拒绝）、2c（A 族放宽 + 通用兜底）、
2d（handler-null 落到下一条规则），均已合并入 main（HEAD `fe13c5f`，78/78）。

## 1. 背景与目标

2c 加了通用兜底：任何未被 withdrawal(A)/balance(C) 匹配的 class1-sub1 TxnRequest 一律回安全的 048
"取消/无法完成"。这保证了不超时，但对**真实主机有确定应答**的交易族是过度简化——它们本应得到各自
专属的 next-state，却统一被兜底成 048。

### 抓包实测（AJMN1301，9263 条已配对 request→紧邻 reply）
按请求 field[7] 首字符分族，主机 TxnReply 的 next-state（field[3]）分布：

| 族 field[7][0] | 请求数 | 主机 next-state | 现状 |
|---|---|---|---|
| `A`（取款） | 1281 | 主 `123`(937 批准)，`048/050/038/154/151`…(拒绝/各屏) | 已覆盖（withdrawal：123/048） |
| `C`（查询） | 997 | `074`(500)、`151`(213)、`077`(171)、`471`(68)… | 已覆盖（balance：一律 074） |
| **`I`** | **15** | **`175`（15/15，100% 一致）** | ❌ 现落 generic 048 |
| **`D`** | **2** | **`698`（2/2，100% 一致）** | ❌ 现落 generic 048 |
| (空 opcode) | 23 | 混合（123 为主） | 落 generic 048 |

关键判断：A/C 已覆盖；**唯一"干净、数据可确定性复现"的新族是 I→175 与 D→698**（各自单一
next-state、100% 一致）。C 的 151/077/471 是**同一 opcode 按真实账户状态分流**（如 `CA   C` 既→074
又→151，253 vs 212），无真实余额/账户状态无法确定性复现——**不纳入本子项目**。

### 目标
给 **I 族**（→175）与 **D 族**（→698）各自专用的 next-state 应答，取代它们当前落到 generic 的 048。

### 已确认的决策
- **范围（用户 2026-07-06 拍板）**：仅 I→175 + D→698。C 子类型分流因不可确定性复现被排除。
- **机制（复用，非新写）**：`generic` handler 已由 `nextState` 参数化，其行为（class-4、fieldG 空
  不出钞、退卡、无 CAM、永不返回 null）正是 I/D 所需，唯一差异是 next-state。故**再实例化两个
  generic**（不同 nextState），**零新 handler 代码**。
- **不硬断言语义**：抓包只确证 D→698、I→175 的 next-state 值。2c 曾假设"D=改密"，但代码里用中性
  命名（`familyD`/`familyI`、规则 `d-family-reply`/`i-family-reply`），语义假设只写进 README 注释。
- **screen/receipt seed**：沿用 generic 默认（空屏、空凭条、退卡、printerFlag `1`、无 CAM），全部可配、
  标注"需真 ATM 校准"——抓包屏幕字段被 PCI 打码，只确知 next-state。

### 非目标（留给以后）
- C 族子类型（151/077/471/…）的专用分流——outcome-dependent，无真实状态不可复现。
- A 族各拒绝 next-state（050/038/154/…）的精确区分——同样 outcome-dependent。
- 空 opcode 族的专门处理——分布混合，无干净映射，继续落 generic 048。
- I/D 的真实屏幕/凭条内容（PCI 打码，未知）、改密确认流程、MAC、真实 EMV。

## 2. 架构

复用 2c/2d 全部基础设施，**engine 与所有 handler 源码零改动**。改动与新增：

```
server.js (mod)     handlers 表新增 familyD / familyI 两个 makeGeneric 实例
config.json (mod)   新增 familyD / familyI 两个 config 块 + d-family-reply / i-family-reply 两条规则
README.md (mod)     I/D 专用 next-state 一节 + 抓包观测来源
test/generic.test.js (mod)   补 nextState 参数化断言（698 / 175）
test/e2e.generic-fallback.test.js (mod)   makeApp 加 D/I 规则+handler；新增 D→698 / I→175 / 非族回归 e2e
```

### 2.1 server.js handler 装配（+2 行）
`createApp` 内 `handlers` 表（现有 goInService/withdrawal/balance/generic）新增：
```js
const handlers = {
  goInService,
  withdrawal: makeWithdrawal(config.withdrawal || {}),
  balance: makeBalance(config.balance || {}),
  familyD: makeGeneric(config.familyD || { nextState: '698' }),
  familyI: makeGeneric(config.familyI || { nextState: '175' }),
  generic: makeGeneric(config.generic || {}),
};
```
注意：`config.familyD || { nextState: '698' }` 的缺省对象只在整块缺失时生效；若 config 提供了
`familyD` 块，则以块内值为准（块内应含 `nextState: '698'`）。makeGeneric 其余项走其自身默认。

### 2.2 config.json 规则顺序（engine 顺序遍历，顺序即优先级）
class1-sub1 内，D/I 专用规则**必须在 generic-fallback 之前**（generic 无 field 约束、会先抢）：
```
withdrawal-request  (class1 sub1, field[7] startsWith "A") → withdrawal
balance-inquiry     (class1 sub1, field[7] startsWith "C") → balance
d-family-reply      (class1 sub1, field[7] startsWith "D") → familyD     ← 新增
i-family-reply      (class1 sub1, field[7] startsWith "I") → familyI     ← 新增
generic-fallback    (class1 sub1, 无 field 约束, 兜底)      → generic
```
D/I 与 A/C 族互斥（startsWith 不同首字符），彼此互斥，故 A/C 与 D/I 的相对次序不影响正确性；
唯一硬约束是 **D/I 均在 generic-fallback 之前**。状态类规则（class2、class1-sub2）不受影响、位置不变。

### 2.3 config.json 新增块
```json
"familyD": { "nextState": "698", "returnCard": "0", "printerFlag": "1", "includeCam": false, "camArc": "00", "receipt": { "screen": "", "printerData": "" } },
"familyI": { "nextState": "175", "returnCard": "0", "printerFlag": "1", "includeCam": false, "camArc": "00", "receipt": { "screen": "", "printerData": "" } }
```
（next-state 698/175 为抓包实测；screen/printer 为空 seed，标注"需真 ATM 校准"。）

## 3. 数据流
```
class1 sub1 TxnRequest → parse → session.remember → engine.respond 顺序遍历：
  field[7] 'A*' → withdrawal → 123 批准(出钞) / 048 拒绝(不出钞)
  field[7] 'C*' → balance    → 074 + 余额(不出钞)
  field[7] 'D*' → familyD    → 698 专用应答(不出钞、退卡、无 CAM)   ← 新
  field[7] 'I*' → familyI    → 175 专用应答(不出钞、退卡、无 CAM)   ← 新
  field[7] 其它(空 opcode/Z 等) → generic → 048 安全兜底
→ server 加长度头回写
```
2e 之后 D/I 族得到实测 next-state 而非 048；其余 class1-sub1 仍由 generic 兜底、保证有应答（2d 不变量）。

## 4. 错误处理
- familyD/familyI 是 generic 实例，对任意 class1-sub1 请求都能构造 reply、**永不返回 null**（继承 generic）。
- 请求缺 luno/mcn 等 → 沿用 extractRequest 的 `|| ''` 默认，reply 合法。
- handler 抛异常 → server per-frame try/catch 捕获，连接存活（不变）。
- D/I 之外仍走既有路径：A→withdrawal（含 null-amount 落 generic，2d 保证）、C→balance、其它→generic。

## 5. 测试策略（Node 内置 node:test，零依赖）
- **单元（`test/generic.test.js` 补断言）**：
  - `makeGeneric({ nextState: '698' })` 对 D 族 class1-sub1 请求 → class 4、next-state `698`、fieldG 空、非 null。
  - `makeGeneric({ nextState: '175' })` 对 I 族请求 → class 4、next-state `175`、fieldG 空、非 null。
  （验证 generic 的 nextState 参数化对新值成立；其余 generic 行为已有单测覆盖。）
- **端到端（`test/e2e.generic-fallback.test.js`：makeApp 的 rules 加 d-family-reply/i-family-reply，
  handlers/config 加 familyD/familyI）**：
  - 发 `D       ` 帧 → 收 class-4、next-state **`698`**、fieldG 空（不再是 048）。
  - 发 `I       ` 帧 → 收 class-4、next-state **`175`**、fieldG 空。
  - 回归：发非 A/C/D/I 的 class1-sub1（如 `Z       ` 或空 opcode）→ 仍 generic **`048`**。
  - 既有 A 族/空金额落 generic 等 e2e 保持通过（回归不破）。

## 6. 构建顺序
1. server.js + config.json：装配 familyD/familyI + 两条规则（置于 generic 前）；补 generic 单测 nextState 断言。
2. e2e：makeApp 加 D/I 装配 + 新增 D→698 / I→175 / 非族→048 三条 e2e；README（I/D 一节 + 抓包观测来源）。
