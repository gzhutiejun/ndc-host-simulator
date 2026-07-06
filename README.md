# NDC Host Simulator

用 Node.js 编写的 ATM 主机（host）模拟器，模拟与 NCR/Atleos APTRA Activate ATM 应用
之间的 **NDC+ over TCP** 通讯，能自动应答 ATM 发来的 NDC 报文。零第三方依赖。

## 协议

- 帧格式：`[2 字节大端长度 N][N 字节 payload]`（N 不含长度头本身）。
- payload 为字符流，控制字符分隔：FS=0x1C、GS=0x1D、RS=0x1E、ETX=0x03。
- 报文首字符=消息类，次字符=子类。ATM→host：`1`=非请求状态、`2`=请求状态；
  host→ATM：`1`=终端命令、`4`=交易应答。

## 运行

```bash
npm start          # 读 config.json 启动
npm test           # 跑单元/端到端测试（node --test）
```

真实 ATM 默认连 `127.0.0.1:2000`，与本模拟器默认端口一致。

## 配置（config.json）

```json
{
  "port": 2000,
  "enableTLS": false,
  "responseDelayMs": 0,
  "tls": { "key": "path/to/key.pem", "cert": "path/to/cert.pem" },
  "rules": [
    { "name": "ready9-go-in-service",
      "match": { "messageClass": "2", "field": { "index": 3, "startsWith": "9" } },
      "handler": "goInService" }
  ]
}
```

- **port**：监听端口（默认 2000）。
- **enableTLS**：是否启用 TLS 1.2（默认 false）。启用时需配置 `tls.key`/`tls.cert`。
- **responseDelayMs**：应答延迟毫秒（默认 0）。
- **rules**：应答规则，按顺序匹配第一条命中的：
  - `match`：谓词，可含 `messageClass`、`subClass`、`type`、`field:{index,equals|startsWith}`；空对象总是匹配。
  - `template`：应答模板，支持占位符 `<FS> <GS> <SO> <SI> <LUNO> <TVN>`。
  - `handler`：JS 处理器名（见 `src/handlers/`），用于需要计算/状态的应答，与 `template` 二选一。
  - `noReply: true`：匹配到但**主机不应答**（如 ReadyB 心跳、设备状态）。与"未匹配"区分——不会告警。

> 默认规则依据真实 ATM（AJMN1301）抓包：主机对 Ready9(`2x`+描述符`9`) 回 go-in-service，
> 对 ReadyB(`B`)/TerminalState(`F`)/设备状态(`12`) 不应答。取款（`ADC`）TransactionRequest→TransactionReply
> 已在默认配置中支持（详见"取款交易流程"节）；余额/转账等其它交易类型属后续子项目，默认配置暂不含。

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
  `<AMOUNT> <PAN> <DATE> <TIME> <RECNO> <LUNO>` 与控制字 `<LF> <FF> <SO> <SI> <GS>`。

> **需用真实 ATM 校准的项**（种子取自 AJMN1301 抓包，终端相关）：
> ① 取款识别谓词 `field[7]=="ADC     "` 与金额索引 `8`；② 出钞用贪心分解（金额吻合但
> 与真实主机的混钞不同，ATM 应可接受任意合法组合）；③ **CAM/EMV 缓冲默认关闭**——真实
> 取款 reply 带含 ARPC 密文（tag 91）的 CAM，离线无法计算该密文；若目标 ATM 需要芯片卡
> 在线发卡行认证，需另行提供。余额/转账等其它交易类型属后续子项目 2b。

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

## 录包

每条收/发报文都会打印 hex dump 并追加到 `captures/session-<时间戳>.log`，
用于分析真实 ATM 报文、迭代应答规则。

## TLS（可选）

生成自签证书用于测试：

```bash
openssl req -x509 -newkey rsa:2048 -keyout key.pem -out cert.pem -days 365 -nodes
```

然后把 `enableTLS` 设为 `true` 并填好 `tls.key`/`tls.cert` 路径。

## 结构

```
server.js          入口 + 装配层（createApp）
src/transport.js   TCP/TLS 服务器
src/framing.js     长度分帧 + 流式拆帧 + latin1 文本编解码
src/ndc/parser.js  NDC 报文解析 + 分类
src/engine.js      混合应答引擎（规则 + 模板 + handler）
src/session.js     每连接会话状态
src/logging.js     hex dump + 录包
src/handlers/      JS 处理器（如 goInService）
```

## License

ISC
