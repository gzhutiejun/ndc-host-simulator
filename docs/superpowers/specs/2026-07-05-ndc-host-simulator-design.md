# NDC Host Simulator — 设计文档

日期：2026-07-05
状态：已确认，待实现

## 1. 背景与目标

`ndc-host-simulator` 是一个用 Node.js 编写的 ATM 主机（host）模拟器。目标客户端是
NCR/Atleos APTRA **Activate** ATM 应用（源码位于
`/Users/tiejunhu/src/atleos/spl-ActivateEnterpriseProduct/`）。ATM 应用通过
**NDC+ 协议 over 原始 TCP** 与 host 通讯，真实配置连接
`127.0.0.1:2000`（见 ATM 项目
`ChnApp/Cnsmr/CnsmrAppAE/Source/Config/TCPIPCommunicationsServiceConfig.XML`）。

本 simulator 要能**自动应答** ATM 发来的报文，最终目标是**完整、可配置的交易流程模拟**。

### 已确认的范围决策

- **应答范围**：完整可配置的交易流程模拟（最终态）。
- **报文来源**：能跑真实 ATM 对接抓包。因此采用**地基优先 + 真实报文迭代**的构建顺序。
- **配置模型**：混合式（JSON 声明式规则 + 可选 JS handler）。
- **依赖策略**：零第三方依赖，仅用 Node 内置模块（`net`/`tls`/`fs`/`node:test`）。

### 范围分解（两个子项目）

- **子项目 1（本 spec）**：传输 + 分帧 + 解析 + 观测（录包）+ 混合应答引擎骨架 +
  上线/状态类内置流程。这是不依赖真实抓包即可做准的部分，也是解锁真实抓包的前提。
- **子项目 2（后续 spec）**：完整交易流程（取款/查询/转账等 Transaction Reply
  下一状态驱动、MAC 校验等），依赖子项目 1 录到的真实报文逐一校准。届时单独立 spec。

## 2. 协议要点（来自 ATM 源码调研）

### 2.1 帧格式

`[2 字节大端长度 N][N 字节 payload]`。长度值为 **payload 字节数，不含 2 字节头本身**。
依据 ATM 端配置 `LengthSize="2" LengthFormat="1"(BigEndian) LengthAdjust="2" LengthEmbedded="0"`
（`ChnSrv/VPITCPIP/Source/StdMessageDelimiter.cs`）。

payload 文本编码为 **windows-1252**（`BusSrv/BusSrvNDC/.../NDCResponse.cs`，
`Constants.DefaultEncoding`）。EBCDIC 为可选，本子项目不做。

**关键修复**：现有代码假设"一次 socket `data` 事件 = 一个完整报文"，真实 TCP 会
粘包/半包。分帧器必须做缓冲拆帧：累积字节，凑够一整帧才吐出。

### 2.2 NDC 报文结构

payload 以字符流表示，控制字符分隔（`BusSrv/BusSrvNDC/Source/Utility/GlobalConstants.cs`）：

- `ETX = 0x03`（报文结束）
- `FS = 0x1C`（字段/sector 分隔）
- `GS = 0x1D`（组分隔）
- `RS = 0x1E`（记录分隔）

每条报文：首字符 = **消息类(message class)**，次字符 = **子类(sub-class)**，随后是
**LUNO**（逻辑单元号/终端号），再是 FS 分隔的各 sector；终端→host 报文以 ETX 结尾，
后面可选 MAC。

**消息类映射**（ATM→host，`TerminalToCentral`）：

| Class | 含义 |
|---|---|
| `1` | 非请求状态 Unsolicited Status |
| `2` | 请求状态 Solicited Status |
| `5` | Exits |
| `6` | Upload EJ Data |

子类：`1` = TransactionRequest / EJUploadData，`2` = StatusMessage。

**消息类映射**（host→ATM，`CentralToTerminal`，即本 simulator 要**发送**的）：

| Class | 含义 |
|---|---|
| `1` | 终端命令 Terminal Command（如 Go In-Service / Out-Of-Service） |
| `3` | 数据命令 Data Command（状态表/屏幕/配置） |
| `4` | **交易应答 Transaction Reply**（子项目 2 核心） |
| `8` | EMV 配置 |

子类：`1` = CustomisationData，`2` = InteractiveTransactionResponse。

### 2.3 参考资料（字节级样本）

- 现有部分 host 模拟器（C#）：`BusSrv/NDCCustomiser/Test/TCPIPTestHost/Source/TCPIPConnectionHost.cs`
- 各消息类型字节样本单测：`BusSrv/BusSrvNDC/Test/RHProxyNDC/*Test.cs`
  （`TransactionReplyTest.cs`、`ReadyStatusTest.cs`、`DeviceStatusTest.cs` 等）
- MAC/TLS：`NDCRequest.cs`（MAC 追加逻辑）、`ChnSrv/VPITCPIP/Source/SecureProtocols.cs`

## 3. 架构

替换现有单文件 `server.js`（258 行）为一组职责单一、可独立测试的模块。建议目录结构：

```
server.js                 入口：读 config，装配各模块，启动 transport
config.json               端口、TLS、应答规则(rules)
src/
  transport.js            TCP + TLS 服务器，连接生命周期
  framing.js              分帧编解码：2字节大端长度头 + 缓冲拆帧，win-1252 编解码
  ndc/parser.js           payload → 结构化 NDC 消息对象
  ndc/constants.js        控制字符、class/subclass 表
  engine.js               混合应答引擎：JSON 规则匹配 + JS handler 分发
  session.js              每连接会话状态（LUNO、TVN/序号计数器）
  logging.js              hex dump + 解码日志 + 落盘录包
  handlers/               JS handler 模块（可选，命中带 handler 的规则时调用）
    goInService.js        示例：收到状态 → 回 Go In-Service 终端命令
captures/                 录包输出目录（.gitignore 忽略内容，保留目录）
test/                     node:test 单测
docs/superpowers/specs/   本设计文档
```

### 3.1 模块职责与接口

**transport.js**
- `createTransport(config, onConnection)`：按 `config.enableTLS` 建 `net`/`tls` 服务器。
- TLS 强制 TLSv1.2（`minVersion`/`maxVersion`），需 `config.tls.key`/`cert`，缺失则报错退出。
- 每个连接回调 `onConnection(socket)`，把 socket 交给上层。
- 默认 `enableTLS=false`（符合真实 config 默认明文）。

**framing.js**
- `createDecoder()`：返回一个有状态的解码器。`decoder.push(buffer)` 累积字节，
  返回本次凑够的完整 payload 数组（`Buffer[]`，已剥离长度头）。处理粘包/半包/多帧。
- `encode(payloadBuffer)`：前置 2 字节大端长度头，返回可 `socket.write` 的 Buffer。
- `decodeText(buffer)` / `encodeText(str)`：windows-1252 编解码。
  说明：Node 的 `Buffer`/`TextDecoder` 支持 `latin1`；windows-1252 与 latin1 在
  0x80–0x9F 区间略有差异，实现里用查表处理该区间以保证准确，或先用 latin1 并在
  测试中标注差异（0x80–0x9F 若出现再补表）。

**ndc/parser.js**
- `parse(payloadBuffer)`：返回 `{ messageClass, subClass, luno, sectors: string[],
  hasETX, mac, raw }`。按 FS 切 sector；识别尾部 ETX 与可选 MAC。
- `classify(parsed)`：依据 class/subclass 表返回语义类型（如 `'TransactionRequest'`、
  `'SolicitedStatus'`、`'UnsolicitedStatus'`）。解析失败不抛断连接，返回带 `raw` 的
  未识别对象，交由 engine 走"未识别"分支。

**engine.js（混合式，方案 C）**
- `createEngine(config, { handlers })`：加载 `config.rules`。
- `respond(parsed, session)`：
  1. 按顺序匹配 `config.rules`（匹配条件：`messageClass`/`subClass`/字段值等谓词）。
  2. 命中带 `template` 的规则：对模板做占位符替换（`<FS>`/`<GS>`/`<SO>`/`<SI>`/
     `<LUNO>`/`<TVN>` 等）→ 返回 payload 字符串。
  3. 命中带 `handler` 的规则：调用 `handlers[name](parsed, session, helpers)`，
     由 handler 返回 payload（可自增 TVN、算下一状态、算 MAC）。
  4. 无命中：返回 `null`，engine 记录"未识别"（不静默丢弃）。
- 占位符替换沿用并扩展现有 `replaceSeperatorAndToUint8Array` 的思路。

**session.js**
- `createSession()`：每连接一个，持有 `luno`、`tvn` 等计数器与 `next()` 之类的辅助。

**logging.js**
- 收发每条报文：打印原始 hex dump（带偏移）、解码后的字段结构、匹配到的规则名。
- **录包**：把每条收/发报文（hex + 解码 + 时间戳 + 方向）追加写入
  `captures/<timestamp>.log`，供子项目 2 用真实报文校准。
- 响应延迟从写死的 `setTimeout(…, 2000)` 改为 `config.responseDelayMs`（默认 0）。

**handlers/goInService.js（示例）**
- 收到 ATM 状态消息后，返回 Go In-Service 终端命令（class `1`），复用现有
  `config` 里 `GIS` 的语义。

### 3.2 数据流

```
socket 'data'
  → framing.decoder.push()  (缓冲拆帧，可能 0/1/多帧)
  → 对每帧 payload:
       framing.decodeText()  → ndc/parser.parse() → classify()
       → logging 录包(收)
       → engine.respond(parsed, session)
            ├─ JSON 模板规则 → 占位符替换
            └─ handler 规则   → 调 JS handler(可用 session)
       → session 更新
       → framing.encodeText() → framing.encode()(加长度头)
       → logging 录包(发)
       → (可选延迟) socket.write()
```

## 4. 配置（config.json）

在现有字段基础上扩展。示例形状：

```json
{
  "port": 2000,
  "enableTLS": false,
  "responseDelayMs": 0,
  "tls": { "key": "path/to/key.pem", "cert": "path/to/cert.pem" },
  "rules": [
    {
      "name": "solicited-status-ready",
      "match": { "messageClass": "2", "subClass": "2" },
      "template": "9<FS>..."
    },
    {
      "name": "go-in-service",
      "match": { "messageClass": "1" },
      "handler": "goInService"
    }
  ]
}
```

- `rules` 取代原先扁平的 `messageMapping`（迁移时把原 `GIS`/`OOS` 语义并入 rules）。
- `match` 是字段谓词；`template`（模板）与 `handler`（JS 处理器名）二选一。
- 未识别报文（无规则命中）记录完整 hex，不静默丢弃。

## 5. 错误处理

- 分帧：长度头声明的长度异常大 → 记录并等待更多字节，设上限防内存膨胀；超限则记录并
  丢弃该连接缓冲。
- 解析失败：返回未识别对象，engine 走未识别分支，完整 hex 落盘，**不断连接、不静默吞掉**
  （修复现有 TLS 分支 opcode 为 null 仍继续跑的 bug）。
- socket error / end：记录并清理会话。
- TLS 证书缺失：启动时明确报错退出。

## 6. 测试策略

Node 内置 `node:test` + `assert`，零第三方依赖。

- **framing**：单帧、粘包（多帧一次到达）、半包（一帧分多次到达）、长度头跨包边界。
- **parser**：各 class/subclass 样本（取自 ATM 项目 `*Test.cs` 的字节样例）、
  ETX/MAC 识别、未识别报文。
- **engine**：规则按序匹配、占位符替换、handler 分发、无命中返回 null。
- **encodeText/decodeText**：windows-1252 往返，含 0x80–0x9F 区间。
- 端到端：起一个 server，用 `net` 客户端发一帧，断言收到正确的长度头 + payload。

## 7. 构建顺序（子项目 1）

1. constants + framing（含单测）——最底层、最易独立验证。
2. parser + classify（含单测，喂 ATM 单测样本）。
3. session + engine + 占位符替换（含单测）。
4. logging + 录包。
5. transport + server.js 装配；端到端冒烟测试。
6. 迁移 config.json（`messageMapping` → `rules`），更新 README 使其与代码一致
   （现 README 与代码有出入：端口、opcode 提取描述均过时）。
7. 内置 `goInService` handler + solicited-status ready 模板，跑真实 ATM 抓包验证。

## 8. 非目标（本子项目不做）

- 完整交易流程（Transaction Reply 下一状态驱动、取款/查询/转账等）→ 子项目 2。
- MAC 生成/校验 → 子项目 2（本子项目在解析层识别 MAC 存在即可）。
- EBCDIC 编码、EMV 配置下载、状态表/屏幕下载。
- host 主动发起连接（ATM 端 `Server`/`LocalPort=2356` 监听路径）。
