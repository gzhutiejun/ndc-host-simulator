# NDC Host Simulator 子项目 2a —— 取款交易流程 设计文档

日期：2026-07-05
状态：已确认，待实现
依赖：子项目 1（模块化 NDC host simulator，已合并入 main）

## 1. 背景与目标

子项目 1 让 simulator 能自动应答 ATM 的状态类报文（上线、心跳）。本子项目 2a 让
simulator 能应答 **取款交易请求**：收到 ATM 的 TransactionRequest(类 `1`/子 `1`)，返回
一条有效的 TransactionReply(类 `4`)，驱动真实 ATM 完成一笔取款（出钞 + 打印 + 退卡 + 回到
就绪）。这是"完整可配置交易流程模拟"的第一个闭环。

### 范围（已确认的决策）
- **只做取款一类**（CASH WITHDRAWAL）跑通闭环；余额/转账/存款/改密留给 2b。
- **reply 构造**：字段级构造器 + 凭条模板（非整体回放）。
- **批准/拒绝**：默认批准，构造器结构上预留 decline 钩子；2a 只实现 approve 分支。
- **出钞**：贪心分解，磁箱面额可配置。
- **凭条**：先做最小可用（够 ATM 出钞完成），完整凭条后续用真 ATM 校准。

### 非目标（留给 2b 及以后）
- 余额查询、转账、存款、改密等其它交易类型。
- 可配置拒绝逻辑（超限/黑名单）的具体规则实现（仅留接口）。
- MAC 生成/校验（本终端实测 MAC 禁用，见 §2）。
- EBCDIC、状态表/屏幕下载。

## 2. 协议事实（来自真实抓包 AJMN1301，2295 对交易）

### 2.1 交易类型分布与下一状态
| 交易 | 数量 | reply next-state (field[3]) |
|---|---|---|
| CASH WITHDRAWAL | 916 | `123` |
| BALANCE INQUIRY | 671 | `074`/`077` |
| 其它 | 706 | `151`/`048`/`471`/`050`… |

### 2.2 出钞 fieldG（reply field[4]）解码
格式：4 个磁箱各 2 位钞票张数 `C1C2C3C4`；本终端磁箱面额
**C1=50, C2=100, C3=500, C4=1000 (AED)**。逐条验证（金额→fieldG）：

| 金额 | fieldG | 分解 |
|---|---|---|
| 50 | `01000000` | 1×50 |
| 100 | `02000000` | 2×50 |
| 300 | `02020000` | 2×50 + 2×100 |
| 500 | `02040000` | 2×50 + 4×100 |
| 1000 | `02040100` | 2×50 + 4×100 + 1×500 |
| 10000 | `02040109` | 100 + 400 + 500 + 9×1000 |

真实主机用"2×50 打底再凑高面额"的特定混钞。**本设计用贪心分解**（大面额优先）——
ATM 只需一个合法且金额吻合的组合即可出钞，不要求复刻真实混钞。

### 2.3 MAC 与 CAM/EMV
- **MAC 禁用**：916 条取款 reply 均无 ETX、无 8 字节 MAC 尾。
- 取款 reply 末尾带 **CAM 缓冲** `<FS>5CAM…8A0230 30`：`8A`=ARC 授权响应码，值
  `"00"`=批准（芯片卡授权响应密文流程）。构造器提供可选 CAM 缓冲，默认带 ARC `00`。

### 2.4 TransactionReply 报文结构（真实取款样例）
```
4<FS>000<FS><FS>123<FS>02020000<FS>6899A040075<SI>@@<FS>>01  <receipt…><LF>…<FS>5CAM…8A023030
类 LUNO  STN 下一状态 fieldG    screen控制块        printer/receipt块        CAM(ARC=00)
```
FS 拆分后：
- field[0]=`4`（类 TransactionReply）
- field[1]=LUNO
- field[2]=STN（实测为空）
- field[3]=下一状态 ID
- field[4]=fieldG（出钞张数）
- field[5]=screen 控制块（`<TrxSerialNo><FunctionID><ScreenNo><DisplayUpdate>`，含 `<SI>` 屏幕切换）
- field[6]=printer 块（`<MsgCoNo><ReturnCardFlag><PrinterFlag><PrinterData>`，可 `<GS>` 分多组）
- 尾部可选缓冲：Track3、CAM、MAC 等（本设计只用 CAM）

### 2.5 TransactionRequest 结构（取款，掩码后）
```
11<FS>LUNO<FS>STN<FS><FS>1=<FS>track2<FS>opcode缓冲<FS>操作码(ADC)<FS>金额(00000300)<FS>…CAM…
```
- 取款请求带 **8 位金额字段**（如 `00000300`=300）与 **操作码缓冲**（实测 `ADC`）；余额查询
  请求无金额。取款识别据此（见 §5）。

## 3. 架构

复用子项目 1 全部模块，**不改** transport/framing/parser/session/engine/logging。新增：

```
src/ndc/transactionRequest.js   从 ParsedMessage 抽取取款字段（金额、操作码、掩码PAN、MCN）
src/ndc/transactionReply.js     字段级 TxnReply 构造器（序列化成 payload 串）
src/dispense.js                 breakdown(amount, cassettes) → fieldG
src/handlers/withdrawal.js      引擎 handler：识别→decide(approve)→出钞→构造 reply→套凭条
config.json                     新增 withdrawal 块 + 一条取款规则
test/                           dispense / transactionReply / withdrawal / e2e 单测
```

引擎的 handler 机制（子项目 1 已有）直接容纳 `withdrawal` handler，签名
`(parsed, session, helpers)`；handler 内部调用新模块构造 reply 串返回。

## 4. 组件与接口

### 4.1 `src/dispense.js`
- `breakdown(amount, cassettes): { fieldG: string, ok: boolean, counts: number[] }`
  - `cassettes`：面额数组，默认 `[50, 100, 500, 1000]`（对应 C1..C4）。
  - 贪心：从大面额到小，凑够 `amount`；无法整除凑齐则 `ok=false`。
  - `fieldG`：每磁箱 2 位十进制张数拼接（`counts` 按 C1..C4 顺序，每个 `padStart(2,'0')`）。
  - 例：`breakdown(300, [50,100,500,1000])` → counts `[0,3,0,0]`（贪心：3×100）→ fieldG `00030000`，`ok=true`。
    （注：与真实主机 `02020000` 不同但金额吻合，ATM 可接受。）

### 4.2 `src/ndc/transactionRequest.js`
- `extractWithdrawal(parsed, config): { isWithdrawal: boolean, amount: number|null, luno, stn, mcn, panMasked }`
  - 依据 `config.withdrawal.identify`（字段谓词，见 §5）判定是否取款。
  - 金额字段：按配置的字段索引取 8 位数字并转 number。

### 4.3 `src/ndc/transactionReply.js`
- `buildTransactionReply(parts): string`，`parts` =
  `{ luno, stn='', nextState, fieldG, screen, printer, returnCard, cam }`。
  - 序列化：`'4' + FS + luno + FS + stn + FS + nextState + FS + fieldG + FS + screen + FS + printerBlock [+ FS + camBlock]`
  - `printerBlock` = `msgCoNo + returnCard + printerFlag + printerData`（`returnCard` 为 1 字符标志：`'0'`=退卡）。
  - `screen`、`printerData`、`camBlock` 均可为空或由模板给出（最小凭条：`printerData` 取最小配置文本）。
  - 纯字符串拼接，不含 ETX（实测无），不含 MAC。

### 4.4 `src/handlers/withdrawal.js`
- 导出 handler `(parsed, session, helpers) => string|null`。流程：
  1. `extractWithdrawal(parsed, config)` 取金额等字段。**取款识别放在规则 `match` 里**
     （见 §5、§6），故 handler 只会收到取款请求；余额等其它 TxnRequest 不匹配本规则、
     自然走 UNMATCHED（与引擎三态语义一致，不会被误当 noReply 静默）。
  2. `decide(request, config)` → `{ approve: true }`（2a 恒 approve；decline 分支留空实现，返回配置的 decline next-state 且不出钞）。
  3. approve：`dispense.breakdown(amount, cassettes)`；`ok=false` → 按 `config.withdrawal.onDispenseError`（默认 `'decline'`）处理。
  4. `applyTemplate` 套凭条模板（占位符 `<AMOUNT>`/`<PAN>`/`<DATE>`/`<TIME>`/`<RECNO>`/`<LUNO>`），日期时间由 helpers 注入的 `now()` 提供（可测试）。
  5. `buildTransactionReply({ luno, nextState: config.approvedNextState, fieldG, returnCard: '0', screen, printer, cam })` → 返回 payload 串。

`helpers` 需新增 `now`（`() => Date`）以便凭条日期时间可测。其余 helpers（applyTemplate/ctx/constants）沿用子项目 1。

## 5. 取款识别（config 可调）

取款识别复用引擎 `matches` 的 `field` 谓词，**直接写进取款规则的 `match`**（不在 handler 内
再判）：`{ messageClass:"1", subClass:"1", field:{ index, equals?|startsWith? } }`。这样余额等
其它 TxnRequest 因 `field` 不匹配而不命中本规则，走 UNMATCHED。

默认种子取自抓包：请求 field[7]（操作码缓冲）= `"ADC     "` 是取款，余额为 `"CC   C  "`；
取款 field[8] 为 8 位金额，余额为空。识别字段索引/值、金额字段索引均可配，交由真 ATM
抓包校准。

## 6. 配置（config.json 新增）

```json
{
  "rules": [
    { "name": "withdrawal-request",
      "match": { "messageClass": "1", "subClass": "1", "field": { "index": 7, "equals": "ADC     " } },
      "handler": "withdrawal" }
    // …子项目 1 的状态类规则保持不变…
  ],
  "withdrawal": {
    "cassettes": [50, 100, 500, 1000],
    "approvedNextState": "123",
    "returnCard": "0",
    "amountFieldIndex": 8,
    "onDispenseError": "decline",
    "declineNextState": "744",
    "includeCam": true,
    "camArc": "00",
    "receipt": {
      "screen": "",
      "printerData": "  CASH WITHDRAWAL<LF>  AED <AMOUNT><LF>  <PAN><LF>  <DATE> <TIME><LF>  REF <RECNO>"
    }
  }
}
```
（字段索引、identify、模板均为种子值，标注"需真 ATM 校准"。）

## 7. 数据流

```
socket data → framing 拆帧 → parser.parse → session.remember
  → engine.respond：规则 withdrawal-request 命中 → handler withdrawal
       → extractWithdrawal（判取款 + 取金额）
       → decide → approve
       → dispense.breakdown(amount) → fieldG
       → applyTemplate(凭条)
       → buildTransactionReply(...) → payload 串
  → engine 返回 { payload, rule } → server 加长度头 → 回写 ATM
```
非取款的 TxnRequest（如余额，field[7]≠`"ADC     "`）：**不命中** withdrawal 规则 →
引擎返回 `{payload:null, rule:null}` → server 记 UNMATCHED（2b 再补相应规则）。

## 8. 错误处理
- 金额缺失/非法/无法凑齐：按 `onDispenseError`（默认 decline）——记录 + 走 decline 分支或
  noReply（可配）；绝不静默产出错误 reply。
- handler 抛异常：被子项目 1 server 的 per-frame try/catch 捕获，连接存活。
- 识别谓词未命中取款：handler 返回 null，按未匹配处理（记录完整 hex）。

## 9. 测试策略（Node 内置 node:test，零依赖）
- **dispense**：多金额→fieldG（含真实样例金额的断言，如 300→ok/counts；50→`01000000` 风格），无法凑齐→`ok=false`。
- **transactionReply builder**：给定 parts 序列化出精确的 FS 结构；含/不含 CAM 两种；returnCard 位置正确。
- **transactionRequest extract**：真实取款请求样本 → isWithdrawal/amount 正确；余额样本 → isWithdrawal=false。
- **withdrawal handler**：真实取款请求 → approve reply（next-state 123 + 正确 fieldG + 凭条占位符替换，注入固定 now）。
- **e2e**：起 createApp（含 withdrawal 规则），发一帧真实取款请求 → 收到一帧 class-4 reply，断言 next-state 123 且 fieldG 与金额吻合。

## 10. 构建顺序
1. dispense.breakdown（+单测）——最底层、纯函数。
2. transactionReply.buildTransactionReply（+单测）。
3. transactionRequest.extractWithdrawal（+单测，喂真实样本）。
4. handlers/withdrawal（+单测）——组合 1-3。
5. helpers 增加 now 注入（engine 传入；默认 `() => new Date()`）。
6. config.json 增加 withdrawal 块 + 规则；e2e 测试；用真 ATM 抓包校准识别谓词/金额索引/凭条。
