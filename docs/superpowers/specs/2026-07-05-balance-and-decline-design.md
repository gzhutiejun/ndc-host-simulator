# NDC Host Simulator 子项目 2b —— 余额查询 + 取款拒绝 设计文档

日期：2026-07-05
状态：已确认，待实现
依赖：子项目 1（模块化 simulator）、子项目 2a（取款交易流程），均已合并入 main

## 1. 背景与目标

2a 让 simulator 能应答取款并**批准出钞**。2b 补上两个互补部分：
1. **余额查询**：应答查询类请求（opcode C 族），返回不出钞、屏幕带余额金额的 TransactionReply。
2. **取款拒绝路径**：把 2a 里"无法处理就返回 null（静默）"的 decline 钩子，变成返回**真实的拒绝
   reply**（class 4、不出钞、decline next-state），使真实 ATM 能显示拒绝而不是超时等待。

### 已确认的决策
- **范围**：余额查询 + 取款拒绝。其它交易类型（转账/存款/改密/对账单）留给 2c。
- **余额金额来源**：固定可配（`config.balance.amount`）。
- **拒绝触发**：可配上限 `maxAmount`（超过则拒绝）**或** 金额无法用磁箱面额凑出。
- **余额识别粒度**：请求 field[7] 以 `'C'` 开头（粗匹配整个 C 族），next-state 统一 `074`（可配）。
- **decline reply**：默认不带 CAM（EMV 拒绝 ARC 密文无法离线计算）。

### 非目标（留给 2c 及以后）
- 转账/存款/改密/迷你对账单等其它交易类型。
- 按 opcode 精确区分 C 族各查询的不同 next-state（077/151/134…）。
- 余额随会话变动（取款后递减）、按卡号映射余额。
- MAC、真实 EMV ARPC 密文。

## 2. 协议事实（来自真实抓包 AJMN1301）

### 2.1 opcode → 交易族
请求 field[7]（8 字符操作码缓冲）首字符区分交易族：
- `A*`（`ADC`/`AAC`/`ABC`）→ 取现族，出钞，reply next-state `123`（拒绝时 `048`/`038`/`050`）。
- `C*`（`CC`/`CA`/`CB`/`CD`）→ 查询族，不出钞，reply next-state `074`/`077`/`151`/`134`。

### 2.2 余额查询报文（真实样例）
```
REQUEST: 11<FS>000<FS><FS><FS>1=<FS>track2<FS><FS>CC   C  <FS><FS>…  (field[8] 金额为空)
REPLY:   4<FS>000<FS><FS>074<FS><FS>48185074075<ESC>[20;80m<SI>FG       454.52 <FS>receipt<FS>5CAM…8A023030
         类 LUNO STN 074  (fieldG空)  screen 含余额 454.52 + 屏幕定位        凭条      CAM
```
- field[3]=next-state `074`；field[4]=fieldG **空**（不出钞）。
- field[5]=screen：`<记录位>074075<ESC>[20;80m<SI>FG       <余额> ` —— 余额金额在 screen 字段，含
  `<ESC>[20;80m`(0x1B 屏幕定位) 与 `<SI>`。
- field[6]=printer(凭条)；field[7]=CAM。

### 2.3 取款拒绝（真实）
同一取款 opcode `ADC` 也出现 next-state `048`(133 次)/`038`/`050` —— 即拒绝/错误路径：class 4、
不出钞（fieldG 空）、不同 next-state。本设计 decline 默认 next-state `048`（可配）。

## 3. 架构

复用 2a 全部：`buildTransactionReply`（已支持空 fieldG）、engine（已有 now 注入）、
transport/framing/parser 不动。改动与新增：

```
src/ndc/receipt.js (new)          共享：applyReceipt + 格式化 + arcToHex + buildCam   [重构]
src/handlers/withdrawal.js (mod)  改用 receipt.js；decline 钩子改为返回真实拒绝 reply
src/ndc/transactionRequest.js(mod) extractWithdrawal 重命名为 extractRequest（中性名）  [重构]
src/handlers/balance.js (new)     makeBalance(cfg) 工厂
server.js (mod)                   装配 balance handler
config.json (mod)                 balance 块 + withdrawal 拒绝配置 + balance 规则
README.md (mod)                   余额/拒绝一节 + 校准说明
test/*                            receipt / balance / withdrawal-decline / e2e 单测
```

### 3.1 重构（改我们正在动的代码，消解 2a 终审的 DRY 项）
- **提取 `src/ndc/receipt.js`**：把 2a `withdrawal.js` 内联的 `applyReceipt`、`fmtAmount`、
  `fmtDate`、`fmtTime`、`arcToHex` 移出为共享导出，供 withdrawal 与 balance 共用。
  `applyReceipt` 扩展：新增占位符 `<BALANCE>`，新增控制字 `<ESC>`(0x1B)；对未提供的占位符替换为
  空串。新增 `buildCam(arc, include): string|null`（`include` 为假返回 null）。
- **重命名 `extractWithdrawal` → `extractRequest`**（`src/ndc/transactionRequest.js`）：函数只抽取
  通用字段 `{amount, luno, stn, mcn, panMasked}`，与具体交易无关；withdrawal 与 balance 共用。
  同步更新 2a 的调用点与测试。

### 3.2 余额 handler（`src/handlers/balance.js`）
- 导出 `makeBalance(cfg)`；`cfg` 取自 `config.balance`。默认：`nextState='074'`、`amount='5000.00'`、
  `returnCard='0'`、`printerFlag='1'`、`includeCam=false`、`camArc='00'`、`receipt={screen,printerData}`。
- handler `(parsed, session, helpers)`：
  1. `extractRequest(parsed)` 取 `luno/mcn/panMasked`（余额请求金额为空，忽略）。
  2. `values = { balance: cfg.amount, pan, date, time, recno: String(session.nextTvn()), luno }`。
  3. `screen = applyReceipt(cfg.receipt.screen, values)`；`printer = mcn + returnCard + printerFlag +
     applyReceipt(cfg.receipt.printerData, values)`；`cam = buildCam(cfg.camArc, cfg.includeCam)`。
  4. `buildTransactionReply({ luno, nextState: cfg.nextState, fieldG: '', screen, printer, cam })`。
  - fieldG 传空串（不出钞）。

### 3.3 取款拒绝（扩展 `src/handlers/withdrawal.js`）
- 新增配置：`maxAmount`（默认 `null`=不限）、`declineNextState`（默认 `'048'`）、
  `declineReceipt={screen,printerData}`。
- 流程改为：
  1. `extractRequest` 取金额；`amount == null` → 返回 `null`（报文异常，无法构造有意义 reply）。
  2. **decline 判定**：`(maxAmount != null && amount > maxAmount)` 或 `breakdown(amount).ok === false`
     → 走 decline：`buildTransactionReply({ luno, nextState: declineNextState, fieldG: '', screen:
     applyReceipt(declineReceipt.screen, values), printer: mcn+returnCard+printerFlag+applyReceipt(
     declineReceipt.printerData, values), cam: null })`。（decline 无出钞、无 CAM。）
  3. 否则 **approve**：与 2a 相同（next-state 123、fieldG、可选 CAM）。
  - approve/decline 的 `values` 都含 `amount`（金额）；approve 另有出钞。

## 4. 配置（config.json 新增/修改）

```json
{
  "rules": [
    { "name": "withdrawal-request", "match": { "messageClass": "1", "subClass": "1", "field": { "index": 7, "equals": "ADC     " } }, "handler": "withdrawal" },
    { "name": "balance-inquiry", "match": { "messageClass": "1", "subClass": "1", "field": { "index": 7, "startsWith": "C" } }, "handler": "balance" }
    // …子项目 1 的状态类规则不变…
  ],
  "withdrawal": {
    "cassettes": [50, 100, 500, 1000], "approvedNextState": "123", "returnCard": "0",
    "amountFieldIndex": 8, "printerFlag": "1", "includeCam": false, "camArc": "00",
    "maxAmount": null,
    "declineNextState": "048",
    "receipt": { "screen": "", "printerData": "<GS>1  CASH WITHDRAWAL<LF>  AED <AMOUNT><LF>  <PAN><LF>  <DATE> <TIME><LF>  REF <RECNO><LF><FF>" },
    "declineReceipt": { "screen": "", "printerData": "<GS>1  WITHDRAWAL DECLINED<LF>  AED <AMOUNT><LF><FF>" }
  },
  "balance": {
    "nextState": "074", "amount": "5000.00", "returnCard": "0", "printerFlag": "1",
    "includeCam": false, "camArc": "00",
    "receipt": {
      "screen": "074075<ESC>[20;80m<SI>FG      <BALANCE> ",
      "printerData": "<GS>1  BALANCE INQUIRY<LF>  AVAIL BAL: AED <BALANCE><LF>  <DATE> <TIME><LF><FF>"
    }
  }
}
```
（identify、next-state、screen 模板、余额金额均为种子/默认值，标注"需真 ATM 校准"。）

## 5. 数据流

```
请求 → framing 拆帧 → parse → session.remember → engine.respond：
  field[7]=='ADC     ' → withdrawal handler → approve(出钞) 或 decline(不出钞) reply
  field[7] 以 'C' 开头 → balance handler → 074 + 余额 reply（不出钞）
  其它 → 无规则命中 → UNMATCHED（2c 再补）
→ server 加长度头回写
```

## 6. 错误处理
- 取款金额缺失/非法 → 返回 null（无法构造 reply），server 记 UNMATCHED。
- 余额请求缺 luno 等 → 用现有默认（`|| ''`）。
- handler 抛异常 → 被 server 的 per-frame try/catch 捕获，连接存活。
- 非 A/C 族的 TxnRequest → 不命中任何规则 → UNMATCHED（不静默）。

## 7. 测试策略（Node 内置 node:test，零依赖）
- **receipt 共享模块**：`applyReceipt` 替换 `<BALANCE>`/`<ESC>` 及原有占位符；`fmtAmount/fmtDate/
  fmtTime`；`arcToHex`；`buildCam(arc,true/false)`。
- **extractRequest 重命名**：2a 原 extractWithdrawal 测试改用新名，行为不变（真实取款/余额样本）。
- **balance handler**：真实 C 族请求 → class 4、next-state 074、fieldG 空、screen 含配置余额、无 CAM。
- **withdrawal decline**：超 maxAmount → decline reply（declineNextState、fieldG 空、不出钞）；无法出钞
  （如 30）→ decline reply（而非 null）；正常金额仍 approve（回归 2a 行为）。
- **端到端**：发真实余额请求帧 → 收到 074 + 余额 reply；发超限取款帧 → 收到 048 decline reply（fieldG 空）。

## 8. 构建顺序
1. 提取 `src/ndc/receipt.js`（含 `<BALANCE>`/`<ESC>`/`buildCam`）+ 重构 withdrawal.js 改用它（回归测试保绿）。
2. 重命名 `extractWithdrawal → extractRequest`（更新调用点与测试）。
3. withdrawal decline：加 maxAmount/declineNextState/declineReceipt + decline 分支 + 单测。
4. `src/handlers/balance.js` + 单测。
5. 装配 server.js（balance handler）+ config.json（balance 块/规则、withdrawal 拒绝配置）+ e2e + README。
