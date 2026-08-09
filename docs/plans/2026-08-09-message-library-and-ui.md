# NDC 主机模拟器：真实报文库 + 浏览器控制台

**Goal:** 让这个模拟器好用到能替掉 NCR 的 AP00_NDCHost——能发真实报文，能实时看见收发，能不重启就换下一条应答。

**Architecture:** 三层，互不耦合。(1) 报文库加载器：纯函数，读 NCR 的定长报文文件；(2) 应答选择：在现有规则引擎之外加一条「手动覆盖」通道；(3) HTTP + 浏览器页面：实时流用 SSE，控制用 POST。零第三方依赖，与现有代码一致。

## Global Constraints

- **零第三方依赖**。只用 Node 内置模块（`http`、`fs`、`path`）。现有代码就是这个口径，不要引入构建步骤或前端框架。
- **不改变现有默认行为**。不配 `messageLibrary`、不开 HTTP 时，模拟器的行为必须与现在**逐字节一致**。现有 98 条测试期望值一处不许改。
- **端口**：NDC 监听 2000（不变），HTTP 控制台 8080（可配 `uiPort`，设为 0 或 false 则不启动）。
- 报文库文件**不入库**：它是 NCR 的文件，体积 640KB，且每台机器路径可能不同。配置里给路径，读不到就降级到现有规则引擎并记一条日志。
- 测试用 `node --test`（现状）。

## 报文库格式（控制器已对真实文件核实）

`C:\Program Files (x86)\NCR APTRA\AP00_NDCHost\MessageFiles\StandardInterface_0300_English_Messages.doc`

扩展名是 `.doc`，**内容是纯文本**（含控制字符，`file` 会报 data，不要被扩展名骗到）。

```
偏移 0    : "M1187RESV\r\n"        —— 11 字节文件头
偏移 11 起: 定长 614 字节的记录，无分隔符
```

每条记录：

| 位置 | 长度 | 内容 |
|---|---|---|
| 0-3 | 4 | 载荷长度，十进制数字，前导零 |
| 4-11 | 8 | 键（NCR 的场景名，如 `GIS     `、`A A  A A`） |
| 12 起 | 上面那个长度 | **载荷 = 完整的 NDC 报文**，含真实控制字符 FS(0x1C)、**SO(0x0E)**、**SI(0x0F)**（控制器原先在此把 SO/SI 写反了，已按标准 ASCII 与本仓 constants.js 订正；实测 SO 重复出现在每行屏幕/凭条数据前，SI 只出现一次、在出钞字段前） |
| 之后 | 补齐到 614 | 空格填充，丢弃 |

实测：`657605 - 11 = 657594 = 614 × 1071`，整除，共 **1071 条**。

载荷样例（`\x1c` 显示为 `|`）：

```
GIS       →  1|||1                             终端命令：Go In Service
OOS       →  1|||2                             终端命令：Go Out Of Service
COMMSKEY  →  3|||32|020193062042095255162143   密钥变更
A A  A A  →  4|000||001|01000000|12342000000<SO>@@|003<SI>7...  交易应答
```

✅ 键里有 912 条**就是**操作码。当初记的「实测对不上（我们的 `A       `/`C       ` 在库里 0 命中）」属实，但原因不是「键不是操作码」，而是 ATM 侧当时只发操作码的位 1、缺了位 3/6/8。ATM 侧已修（见 acc-ndc-app 的 `docs/superpowers/specs/2026-08-09-ndc-transaction-request-design.md` §2.1），现在 `opcode-library` 规则直接拿操作码查库。库的另一个用途仍然是**给人挑**。

---

## Task 1: 报文库加载器

**Files:**
- Create: `src/message-library.js`
- Create: `test/message-library.test.js`

**Produces:**
- `parseLibrary(buffer|string) → [{ key, payload }]`
- `describe(payload) → { messageClass, subClass, label, fields }` —— 从载荷推出人类可读的标签

- [ ] **Step 1: 先写失败的测试**

用**内联构造的**记录（不要依赖真实文件，CI 上没有它）：拼一条 614 字节的记录，断言解析出 key 与 payload；再拼两条，断言按 614 边界正确切分；断言尾部空格被丢弃而**载荷内部的空格保留**（`A A  A A` 这种键本身含空格，`GIS     ` 的键尾空格要 trim 还是保留，你定，但要在测试里钉住并说明理由）。

- [ ] **Step 2: 跑测试确认失败**

- [ ] **Step 3: 实现 parseLibrary**

按上表切分。健壮性要求：长度字段不是数字、或声明长度超出记录、或文件长度不是 `11 + 614n`——都不要抛，跳过坏记录并在返回值里带上 `skipped` 计数，让调用方能记日志。**模拟器不能因为库文件有一行坏了就起不来。**

- [ ] **Step 4: 实现 describe**

`A A  A A` 这种键人看不出是什么，页面上必须有可读标签。从载荷推：

- 首字符 = 报文类（`1` 终端命令、`3` 密钥、`4` 交易应答）
- 类 `1`：第 4 段是命令码，映射成 `Go In Service` / `Go Out Of Service` / `Send Configuration ID` 等（手册 Table 10-1）
- 类 `4`：取 next state（第 4 段）与出钞面额组合（第 5 段），拼成 `交易应答 · 下一状态 001 · 出钞 01000000`

拿不准的就回退到 `类 N 报文`，**不要编**。

- [ ] **Step 5: 跑测试确认通过；提交**

---

## Task 2: 手动覆盖通道

**Files:**
- Modify: `src/engine.js`、`server.js`
- Modify: `test/engine.test.js`

**Consumes:** Task 1 的 `parseLibrary`。

**要点：** 在规则引擎**之前**插一个「一次性覆盖」检查：若被设置了 `nextResponse`，则下一条匹配的入站报文用它作答，用完即清（一次性，避免忘了关一直生效）。没设置时**走原有规则，行为完全不变**。

覆盖可以是：库里的某个 key、一段原始载荷、或 `noReply`（模拟主机不回，用来测超时）。

- [ ] Step 1-5: 测试先行，尤其钉住「未设置覆盖时行为与改动前逐字节一致」。

---

## Task 3: HTTP 控制台

**Files:**
- Create: `src/ui-server.js`、`src/ui/index.html`（单文件，内联 CSS/JS）
- Modify: `server.js`
- Create: `test/ui-server.test.js`

**要点：**

- `GET /` → 页面；`GET /api/library` → 报文列表（key + describe 的标签）；`GET /api/stream` → SSE 实时推送收发帧；`POST /api/next` → 设置下一条应答；`POST /api/push` → 立刻下发一条终端命令（不等 ATM 请求）。
- **实时流每帧一行**：方向、字节数、解码后的字段（控制字符渲染成可见符号：FS→`|`、GS→`~`、RS→`^`、SO(0x0E)→`<`、SI(0x0F)→`>`）、命中的规则名。
- 页面三块：上方实时流（自动滚动、可暂停）、下方左侧报文库（可搜索、点一下设为下一条应答）、下方右侧快捷按钮（进服务 / 停业 / 不回包 / 自定义）。
- `uiPort` 未配置或为 0 时**完全不启动 HTTP**，且不影响 NDC 服务。

- [ ] Step 1-5: 测试覆盖各 API 的契约（不测页面渲染），并钉住「不配 uiPort 时不监听」。

---

## 验证

- `npm test` 全绿，现有 98 条**期望值一处未改**。
- 不配 `messageLibrary` 与 `uiPort` 时，与改动前行为逐字节一致。
- 人工：指向真实报文文件启动，页面能列出 1071 条、能挑一条、ATM 侧收到的就是那条。
