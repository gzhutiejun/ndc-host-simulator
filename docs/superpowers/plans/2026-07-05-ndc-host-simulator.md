# NDC Host Simulator Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把现有单文件 `server.js` 重构为一个模块化、可配置、带录包观测的 NDC host simulator，能自动应答 ATM（APTRA Activate）发来的 NDC 状态类报文，并为后续完整交易流程打好地基。

**Architecture:** 分层模块 —— transport（TCP/TLS）→ framing（2字节大端长度分帧 + 流式缓冲拆帧 + 字节保真文本编解码）→ ndc/parser（结构化解析 + 分类）→ engine（混合式：JSON 规则匹配 + 占位符模板 + 可选 JS handler）→ session（每连接状态）→ logging（hex dump + 落盘录包）。数据流：`socket data → 拆帧 → 解析 → 录包 → 引擎应答 → 加长度头 → 写回`。

**Tech Stack:** Node.js（>=12，实际用 >=18 以获得稳定的 `node --test`），零第三方依赖。测试用内置 `node:test` + `node:assert`。

## Global Constraints

- **零第三方依赖**：只允许 Node 内置模块（`net`、`tls`、`fs`、`path`、`node:test`、`node:assert`）。`package.json` 不得新增 dependencies/devDependencies。
- **帧格式**：`[2 字节大端长度 N][N 字节 payload]`，N = payload 字节数，不含 2 字节头本身。
- **文本编解码**：用 `latin1`（ISO-8859-1）做字节保真的 payload↔字符串转换。理由：latin1 把 0x00–0xFF 一一映射到 U+0000–U+00FF，往返零丢失；NDC 字段内容为 ASCII + 控制字符，无需 windows-1252 的 0x80–0x9F 排版语义，字节保真才是模拟器要的。
- **控制字符**：FS=0x1C，GS=0x1D，RS=0x1E，ETX=0x03，SO=0x0E，SI=0x0F。
- **消息分类**（payload 首字符=class，次字符=subClass）：ATM→host `1`=UnsolicitedStatus、`2`=SolicitedStatus、`5`=Exit、`6`=UploadEJ；子类 `1`=TransactionRequest、`2`=StatusMessage。host→ATM `1`=TerminalCommand、`3`=DataCommand、`4`=TransactionReply、`8`=EMVConfig。
- **解析必须保留空字段**（`includeEmpty:true` 语义）：FS 拆分后不得丢弃空段，否则字段索引错位。
- **测试命令**：`node --test`（跑 `test/` 下全部）；单文件 `node --test test/<name>.test.js`。
- **未识别报文不得静默丢弃**：必须记录完整 hex。

## 文件结构

```
server.js                 入口：读 config、装配模块、启动 transport（Task 10 重写）
config.json               port / enableTLS / responseDelayMs / tls / rules（Task 10 迁移）
package.json              加 "test": "node --test"（Task 1）
src/
  constants.js            控制字符 + class/subclass/状态描述符表（Task 1）
  framing.js              长度分帧 encode + 流式 decoder + latin1 文本编解码（Task 2、3）
  ndc/parser.js           payload Buffer → 结构化 NDC 对象 + classify（Task 4）
  session.js              每连接会话状态（Task 5）
  engine.js               规则匹配 + 占位符模板 + handler 分发（Task 6）
  handlers/goInService.js 示例 handler：状态 → Go-In-Service 终端命令（Task 7）
  logging.js              hex dump + 落盘录包（Task 8）
  transport.js            TCP + TLS 服务器（Task 9）
captures/                 录包输出目录（.gitignore 忽略 *.log，保留 .gitkeep）
test/                     node:test 单测
docs/superpowers/         spec 与本 plan
```

---

### Task 1: 项目脚手架 + 常量模块

**Files:**
- Modify: `package.json`（加 test 脚本）
- Create: `src/constants.js`
- Create: `test/constants.test.js`
- Create: `captures/.gitkeep`（空文件）

**Interfaces:**
- Consumes: 无
- Produces: `src/constants.js` 导出
  - `FS, GS, RS, ETX, SO, SI`（均为单字符 string，值见 Global Constraints）
  - `STATUS_DESCRIPTOR = { DEVICE_FAULT: '8', READY9: '9', READY_B: 'B', TERMINAL_STATE: 'F' }`
  - `T2C_CLASS = { '1':'UnsolicitedStatus', '2':'SolicitedStatus', '5':'Exit', '6':'UploadEJ' }`
  - `C2T_CLASS = { '1':'TerminalCommand', '3':'DataCommand', '4':'TransactionReply', '8':'EMVConfig' }`
  - `SUBCLASS = { '1':'TransactionRequest', '2':'StatusMessage' }`

- [ ] **Step 1: 写失败测试**

Create `test/constants.test.js`:

```js
const test = require('node:test');
const assert = require('node:assert');
const C = require('../src/constants');

test('control characters have exact byte values', () => {
  assert.strictEqual(C.FS.charCodeAt(0), 0x1c);
  assert.strictEqual(C.GS.charCodeAt(0), 0x1d);
  assert.strictEqual(C.RS.charCodeAt(0), 0x1e);
  assert.strictEqual(C.ETX.charCodeAt(0), 0x03);
  assert.strictEqual(C.SO.charCodeAt(0), 0x0e);
  assert.strictEqual(C.SI.charCodeAt(0), 0x0f);
});

test('class and status tables map known codes', () => {
  assert.strictEqual(C.T2C_CLASS['2'], 'SolicitedStatus');
  assert.strictEqual(C.C2T_CLASS['4'], 'TransactionReply');
  assert.strictEqual(C.SUBCLASS['1'], 'TransactionRequest');
  assert.strictEqual(C.STATUS_DESCRIPTOR.READY_B, 'B');
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `node --test test/constants.test.js`
Expected: FAIL —— `Cannot find module '../src/constants'`

- [ ] **Step 3: 实现 constants.js**

Create `src/constants.js`:

```js
const FS = String.fromCharCode(0x1c);
const GS = String.fromCharCode(0x1d);
const RS = String.fromCharCode(0x1e);
const ETX = String.fromCharCode(0x03);
const SO = String.fromCharCode(0x0e);
const SI = String.fromCharCode(0x0f);

const STATUS_DESCRIPTOR = {
  DEVICE_FAULT: '8',
  READY9: '9',
  READY_B: 'B',
  TERMINAL_STATE: 'F',
};

const T2C_CLASS = {
  '1': 'UnsolicitedStatus',
  '2': 'SolicitedStatus',
  '5': 'Exit',
  '6': 'UploadEJ',
};

const C2T_CLASS = {
  '1': 'TerminalCommand',
  '3': 'DataCommand',
  '4': 'TransactionReply',
  '8': 'EMVConfig',
};

const SUBCLASS = {
  '1': 'TransactionRequest',
  '2': 'StatusMessage',
};

module.exports = {
  FS, GS, RS, ETX, SO, SI,
  STATUS_DESCRIPTOR, T2C_CLASS, C2T_CLASS, SUBCLASS,
};
```

- [ ] **Step 4: 加 test 脚本 + 建 captures 目录**

修改 `package.json` 的 `scripts`，从：

```json
  "scripts": {
    "start": "node server.js"
  },
```

改为：

```json
  "scripts": {
    "start": "node server.js",
    "test": "node --test"
  },
```

创建空文件 `captures/.gitkeep`（内容为空）。

- [ ] **Step 5: 运行测试确认通过**

Run: `node --test test/constants.test.js`
Expected: PASS（2 tests）

- [ ] **Step 6: 提交**

```bash
git add package.json src/constants.js test/constants.test.js captures/.gitkeep
git commit -m "feat: add NDC constants module and test scaffolding"
```

---

### Task 2: framing —— 长度分帧 encode + 流式 decoder

**Files:**
- Create: `src/framing.js`
- Create: `test/framing.test.js`

**Interfaces:**
- Consumes: 无
- Produces: `src/framing.js` 导出
  - `encodeLength(payload: Buffer): Buffer` —— 返回 `[2字节大端长度][payload]`
  - `createDecoder(): { push(chunk: Buffer): Buffer[] }` —— 有状态流式拆帧器；`push` 累积字节，返回本次凑齐的完整 payload 数组（已剥离长度头，可能返回 0/1/多个）。处理粘包、半包、跨包长度头。
  - `MAX_FRAME = 65535`（长度头 2 字节的上限，天然由格式决定）

- [ ] **Step 1: 写失败测试**

Create `test/framing.test.js`:

```js
const test = require('node:test');
const assert = require('node:assert');
const { encodeLength, createDecoder } = require('../src/framing');

test('encodeLength prefixes 2-byte big-endian length', () => {
  const out = encodeLength(Buffer.from('AB', 'latin1'));
  assert.deepStrictEqual([...out], [0x00, 0x02, 0x41, 0x42]);
});

test('decoder returns a single complete frame', () => {
  const d = createDecoder();
  const frame = encodeLength(Buffer.from('hello', 'latin1'));
  const frames = d.push(frame);
  assert.strictEqual(frames.length, 1);
  assert.strictEqual(frames[0].toString('latin1'), 'hello');
});

test('decoder splits two frames arriving in one chunk (粘包)', () => {
  const d = createDecoder();
  const chunk = Buffer.concat([
    encodeLength(Buffer.from('AA', 'latin1')),
    encodeLength(Buffer.from('BBB', 'latin1')),
  ]);
  const frames = d.push(chunk);
  assert.deepStrictEqual(frames.map((f) => f.toString('latin1')), ['AA', 'BBB']);
});

test('decoder reassembles a frame split across chunks (半包)', () => {
  const d = createDecoder();
  const full = encodeLength(Buffer.from('WORLD', 'latin1'));
  assert.deepStrictEqual(d.push(full.subarray(0, 3)), []); // 长度头都没凑齐
  const frames = d.push(full.subarray(3));
  assert.strictEqual(frames.length, 1);
  assert.strictEqual(frames[0].toString('latin1'), 'WORLD');
});

test('decoder handles length header split across chunks', () => {
  const d = createDecoder();
  const full = encodeLength(Buffer.from('XY', 'latin1')); // [00 02 58 59]
  assert.deepStrictEqual(d.push(full.subarray(0, 1)), []); // 只有 1 个长度字节
  const frames = d.push(full.subarray(1));
  assert.strictEqual(frames[0].toString('latin1'), 'XY');
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `node --test test/framing.test.js`
Expected: FAIL —— `Cannot find module '../src/framing'`

- [ ] **Step 3: 实现 framing.js（先只做分帧部分）**

Create `src/framing.js`:

```js
const MAX_FRAME = 0xffff;

function encodeLength(payload) {
  const buf = payload instanceof Buffer ? payload : Buffer.from(payload, 'latin1');
  const header = Buffer.allocUnsafe(2);
  header.writeUInt16BE(buf.length, 0);
  return Buffer.concat([header, buf]);
}

function createDecoder() {
  let acc = Buffer.alloc(0);
  return {
    push(chunk) {
      acc = acc.length === 0 ? chunk : Buffer.concat([acc, chunk]);
      const frames = [];
      // 循环：只要缓冲里能凑齐 [2字节头 + N] 就吐一帧
      while (acc.length >= 2) {
        const len = acc.readUInt16BE(0);
        if (acc.length < 2 + len) break; // 半包，等更多字节
        frames.push(acc.subarray(2, 2 + len));
        acc = acc.subarray(2 + len);
      }
      return frames;
    },
  };
}

module.exports = { encodeLength, createDecoder, MAX_FRAME };
```

- [ ] **Step 4: 运行测试确认通过**

Run: `node --test test/framing.test.js`
Expected: PASS（5 tests）

- [ ] **Step 5: 提交**

```bash
git add src/framing.js test/framing.test.js
git commit -m "feat: add length-prefix framing with streaming decoder"
```

---

### Task 3: framing —— latin1 字节保真文本编解码

**Files:**
- Modify: `src/framing.js`（新增两个导出）
- Modify: `test/framing.test.js`（追加测试）

**Interfaces:**
- Consumes: 无
- Produces: `src/framing.js` 新增导出
  - `encodeText(str: string): Buffer` —— latin1 编码
  - `decodeText(buf: Buffer): string` —— latin1 解码

- [ ] **Step 1: 追加失败测试**

在 `test/framing.test.js` 末尾追加：

```js
const { encodeText, decodeText } = require('../src/framing');

test('encodeText/decodeText round-trip all bytes 0x00-0xFF (字节保真)', () => {
  const bytes = Buffer.from(Array.from({ length: 256 }, (_, i) => i));
  const str = decodeText(bytes);
  const back = encodeText(str);
  assert.deepStrictEqual([...back], [...bytes]);
});

test('decodeText preserves control chars', () => {
  const buf = Buffer.from([0x32, 0x32, 0x1c, 0x39]); // "22" FS "9"
  assert.strictEqual(decodeText(buf), '22\x1c9');
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `node --test test/framing.test.js`
Expected: FAIL —— `encodeText is not a function`

- [ ] **Step 3: 实现文本编解码**

在 `src/framing.js` 中，把 `module.exports` 之前加入：

```js
function encodeText(str) {
  return Buffer.from(str, 'latin1');
}

function decodeText(buf) {
  return buf.toString('latin1');
}
```

并把 `module.exports` 改为：

```js
module.exports = { encodeLength, createDecoder, MAX_FRAME, encodeText, decodeText };
```

- [ ] **Step 4: 运行测试确认通过**

Run: `node --test test/framing.test.js`
Expected: PASS（7 tests）

- [ ] **Step 5: 提交**

```bash
git add src/framing.js test/framing.test.js
git commit -m "feat: add latin1 byte-preserving text codec"
```

---

### Task 4: ndc/parser —— 结构化解析 + 分类

**Files:**
- Create: `src/ndc/parser.js`
- Create: `test/parser.test.js`

**Interfaces:**
- Consumes: `src/constants.js`（FS、ETX、T2C_CLASS、SUBCLASS）；`src/framing.js`（decodeText）
- Produces: `src/ndc/parser.js` 导出
  - `parse(payload: Buffer): ParsedMessage`
    - `ParsedMessage = { messageClass, subClass, luno, fields, hasETX, mac, type, raw }`
    - `messageClass`：payload 首字符（string）；`subClass`：次字符
    - `fields`：payload 文本按 FS 拆分的数组，**保留空字段**；`fields[0]` 即 class+subClass 那一段（如 `"22"`）；`fields[1]` = LUNO
    - `luno`：`fields[1]`（无则 `''`）
    - `hasETX`：payload 是否以 ETX(0x03) 结尾
    - `mac`：本子项目恒为 `null`（仅占位，子项目 2 再填）
    - `type`：见下方 classify 规则
    - `raw`：原始 payload Buffer
  - classify 规则：
    - class `'1'` & subClass `'1'` → `'TransactionRequest'`
    - class `'1'` & subClass `'2'` → `'UnsolicitedStatus'`
    - class `'2'` → `'SolicitedStatus'`
    - 其余按 `T2C_CLASS[class]`，取不到则 `'Unknown'`

- [ ] **Step 1: 写失败测试（用真实报文样本）**

Create `test/parser.test.js`:

```js
const test = require('node:test');
const assert = require('node:assert');
const { parse } = require('../src/ndc/parser');
const { FS, ETX } = require('../src/constants');
const { encodeText } = require('../src/framing');

// 来自 ATM 项目 ReadyStatusTest.cs: Ready9 solicited status
test('parses Ready9 solicited status "22<FS>123<FS><FS>9"', () => {
  const p = parse(encodeText('22' + FS + '123' + FS + FS + '9'));
  assert.strictEqual(p.messageClass, '2');
  assert.strictEqual(p.subClass, '2');
  assert.strictEqual(p.luno, '123');
  assert.deepStrictEqual(p.fields, ['22', '123', '', '9']); // 空字段被保留
  assert.strictEqual(p.type, 'SolicitedStatus');
  assert.strictEqual(p.hasETX, false);
});

// ReadyB + 真实抓包尾随数据（现有 server.js 里的 "B0000" 触发）
test('parses ReadyB solicited status with trailing data', () => {
  const p = parse(encodeText('22' + FS + '000' + FS + FS + 'B0000'));
  assert.strictEqual(p.type, 'SolicitedStatus');
  assert.strictEqual(p.fields[3], 'B0000');
});

// 来自 TransactionRequestTest.cs: transaction request 前缀 "11"
test('parses transaction request "11<FS>123<FS>..." as TransactionRequest', () => {
  const p = parse(encodeText('11' + FS + '123' + FS + FS + FS + '1'));
  assert.strictEqual(p.messageClass, '1');
  assert.strictEqual(p.subClass, '1');
  assert.strictEqual(p.type, 'TransactionRequest');
  assert.strictEqual(p.luno, '123');
});

test('detects trailing ETX', () => {
  const p = parse(encodeText('11' + FS + '123' + ETX));
  assert.strictEqual(p.hasETX, true);
});

test('unknown class falls back to Unknown type', () => {
  const p = parse(encodeText('ZZ' + FS + '123'));
  assert.strictEqual(p.type, 'Unknown');
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `node --test test/parser.test.js`
Expected: FAIL —— `Cannot find module '../src/ndc/parser'`

- [ ] **Step 3: 实现 parser.js**

Create `src/ndc/parser.js`:

```js
const { FS, ETX, T2C_CLASS } = require('../constants');
const { decodeText } = require('../framing');

function classify(messageClass, subClass) {
  if (messageClass === '1' && subClass === '1') return 'TransactionRequest';
  if (messageClass === '1' && subClass === '2') return 'UnsolicitedStatus';
  if (messageClass === '2') return 'SolicitedStatus';
  return T2C_CLASS[messageClass] || 'Unknown';
}

function parse(payload) {
  const text = decodeText(payload);
  const hasETX = text.length > 0 && text.charCodeAt(text.length - 1) === ETX.charCodeAt(0);
  const body = hasETX ? text.slice(0, -1) : text;

  const fields = body.split(FS); // 保留空字段
  const messageClass = body.charAt(0) || '';
  const subClass = body.charAt(1) || '';
  const luno = fields.length > 1 ? fields[1] : '';

  return {
    messageClass,
    subClass,
    luno,
    fields,
    hasETX,
    mac: null,
    type: classify(messageClass, subClass),
    raw: payload,
  };
}

module.exports = { parse, classify };
```

- [ ] **Step 4: 运行测试确认通过**

Run: `node --test test/parser.test.js`
Expected: PASS（5 tests）

- [ ] **Step 5: 提交**

```bash
git add src/ndc/parser.js test/parser.test.js
git commit -m "feat: add NDC message parser and classifier"
```

---

### Task 5: session —— 每连接会话状态

**Files:**
- Create: `src/session.js`
- Create: `test/session.test.js`

**Interfaces:**
- Consumes: 无
- Produces: `src/session.js` 导出
  - `createSession(): Session`
  - `Session = { luno: string|null, tvn: number, nextTvn(): number, remember(parsed): void }`
    - `nextTvn()`：自增并返回新的 tvn（从 1 起）
    - `remember(parsed)`：若 `parsed.luno` 非空则记到 `session.luno`

- [ ] **Step 1: 写失败测试**

Create `test/session.test.js`:

```js
const test = require('node:test');
const assert = require('node:assert');
const { createSession } = require('../src/session');

test('nextTvn increments from 1', () => {
  const s = createSession();
  assert.strictEqual(s.nextTvn(), 1);
  assert.strictEqual(s.nextTvn(), 2);
  assert.strictEqual(s.tvn, 2);
});

test('remember captures luno from parsed message', () => {
  const s = createSession();
  s.remember({ luno: '123' });
  assert.strictEqual(s.luno, '123');
  s.remember({ luno: '' }); // 空不覆盖
  assert.strictEqual(s.luno, '123');
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `node --test test/session.test.js`
Expected: FAIL —— `Cannot find module '../src/session'`

- [ ] **Step 3: 实现 session.js**

Create `src/session.js`:

```js
function createSession() {
  const session = {
    luno: null,
    tvn: 0,
    nextTvn() {
      session.tvn += 1;
      return session.tvn;
    },
    remember(parsed) {
      if (parsed && parsed.luno) session.luno = parsed.luno;
    },
  };
  return session;
}

module.exports = { createSession };
```

- [ ] **Step 4: 运行测试确认通过**

Run: `node --test test/session.test.js`
Expected: PASS（2 tests）

- [ ] **Step 5: 提交**

```bash
git add src/session.js test/session.test.js
git commit -m "feat: add per-connection session state"
```

---

### Task 6: engine —— 规则匹配 + 占位符模板 + handler 分发

**Files:**
- Create: `src/engine.js`
- Create: `test/engine.test.js`

**Interfaces:**
- Consumes: `src/constants.js`（FS、GS、SO、SI）；`ParsedMessage`（Task 4）；`Session`（Task 5）
- Produces: `src/engine.js` 导出
  - `applyTemplate(template: string, ctx: object): string` —— 替换占位符 `<FS> <GS> <SO> <SI>`（来自 constants）以及 `<LUNO> <TVN>`（来自 ctx）。未知占位符原样保留。
  - `matches(match: object, parsed: ParsedMessage): boolean` —— 支持字段：`messageClass`、`subClass`、`type`、`field:{index, equals?, startsWith?}`。全部提供的条件都满足才返回 true。空 `match`（`{}`）视为总是匹配。
  - `createEngine({ rules, handlers }): { respond(parsed, session): { payload: string|null, rule: string|null } }`
    - `respond`：按顺序找第一条 `matches` 命中的规则，返回 `{ payload, rule }`：
      - 无命中 → `{ payload: null, rule: null }`（真正的"未识别"）
      - 命中带 `noReply: true` 的 → `{ payload: null, rule: rule.name }`（**匹配到但主机不应答**，如 ReadyB 心跳/设备状态；与未识别区分开）
      - 命中带 `template` 的 → `{ payload: applyTemplate(template, ctx), rule: rule.name }`
      - 命中带 `handler` 的 → `{ payload: handlers[rule.handler](parsed, session, helpers), rule: rule.name }`
    - `ctx`：`{ luno: session.luno || parsed.luno || '', tvn: String(session.tvn) }`
    - `helpers`：`{ applyTemplate, ctx, constants }`（handler 用它来套模板/取控制字符）
    - **依据真实抓包**：AJMN1301 的 9263 条报文里，主机对 ReadyB(`2x`+`fields[3]`起始 `B`) 和设备状态(`12`) 从不应答（3800+ 条），只对 Ready9(`9`)/TerminalState(`F`) 回终端命令，对 TxnRequest(`11`) 回 TxnReply(`4`)。故 `noReply` 是一等公民。

- [ ] **Step 1: 写失败测试**

Create `test/engine.test.js`:

```js
const test = require('node:test');
const assert = require('node:assert');
const { applyTemplate, matches, createEngine } = require('../src/engine');
const { FS } = require('../src/constants');
const { parse } = require('../src/ndc/parser');
const { encodeText } = require('../src/framing');
const { createSession } = require('../src/session');

test('applyTemplate substitutes control chars and context', () => {
  const out = applyTemplate('1<FS><FS><FS>1', {});
  assert.strictEqual(out, '1' + FS + FS + FS + '1');
  const out2 = applyTemplate('L=<LUNO> T=<TVN>', { luno: '123', tvn: '7' });
  assert.strictEqual(out2, 'L=123 T=7');
});

test('matches checks class, subClass, type and field predicates', () => {
  const p = parse(encodeText('22' + FS + '123' + FS + FS + 'B0000'));
  assert.strictEqual(matches({ messageClass: '2' }, p), true);
  assert.strictEqual(matches({ messageClass: '1' }, p), false);
  assert.strictEqual(matches({ type: 'SolicitedStatus' }, p), true);
  assert.strictEqual(matches({ field: { index: 3, startsWith: 'B' } }, p), true);
  assert.strictEqual(matches({ field: { index: 3, equals: '9' } }, p), false);
  assert.strictEqual(matches({}, p), true);
});

test('respond picks first matching template rule', () => {
  const engine = createEngine({
    rules: [{ name: 'gis', match: { messageClass: '2', field: { index: 3, startsWith: '9' } }, template: '1<FS><FS><FS>1' }],
    handlers: {},
  });
  const p = parse(encodeText('22' + FS + '123' + FS + FS + '9'));
  const out = engine.respond(p, createSession());
  assert.strictEqual(out.payload, '1' + FS + FS + FS + '1');
  assert.strictEqual(out.rule, 'gis');
});

test('respond dispatches to a handler', () => {
  const engine = createEngine({
    rules: [{ name: 'h', match: { type: 'SolicitedStatus' }, handler: 'echoLuno' }],
    handlers: {
      echoLuno: (parsed, session, helpers) => helpers.applyTemplate('X<LUNO>', helpers.ctx),
    },
  });
  const p = parse(encodeText('22' + FS + '777' + FS + FS + '9'));
  const out = engine.respond(p, createSession());
  assert.strictEqual(out.payload, 'X777');
});

test('respond honours noReply rule (matched but silent)', () => {
  // 真实主机对 ReadyB 心跳不应答，但仍是"匹配到"，不能当未识别
  const engine = createEngine({
    rules: [{ name: 'ready-b-idle', match: { messageClass: '2', field: { index: 3, startsWith: 'B' } }, noReply: true }],
    handlers: {},
  });
  const p = parse(encodeText('22' + FS + '000' + FS + FS + 'B'));
  const out = engine.respond(p, createSession());
  assert.strictEqual(out.payload, null);
  assert.strictEqual(out.rule, 'ready-b-idle');
});

test('respond returns null rule when no rule matches (真正未识别)', () => {
  const engine = createEngine({ rules: [{ name: 'x', match: { messageClass: '9' }, template: 'Z' }], handlers: {} });
  const p = parse(encodeText('22' + FS + '123'));
  const out = engine.respond(p, createSession());
  assert.strictEqual(out.payload, null);
  assert.strictEqual(out.rule, null);
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `node --test test/engine.test.js`
Expected: FAIL —— `Cannot find module '../src/engine'`

- [ ] **Step 3: 实现 engine.js**

Create `src/engine.js`:

```js
const constants = require('./constants');
const { FS, GS, SO, SI } = constants;

function applyTemplate(template, ctx) {
  return template
    .replace(/<FS>/g, FS)
    .replace(/<GS>/g, GS)
    .replace(/<SO>/g, SO)
    .replace(/<SI>/g, SI)
    .replace(/<LUNO>/g, ctx.luno != null ? ctx.luno : '')
    .replace(/<TVN>/g, ctx.tvn != null ? ctx.tvn : '');
}

function matches(match, parsed) {
  if (!match) return true;
  if (match.messageClass != null && parsed.messageClass !== match.messageClass) return false;
  if (match.subClass != null && parsed.subClass !== match.subClass) return false;
  if (match.type != null && parsed.type !== match.type) return false;
  if (match.field != null) {
    const value = parsed.fields[match.field.index];
    if (value == null) return false;
    if (match.field.equals != null && value !== match.field.equals) return false;
    if (match.field.startsWith != null && !value.startsWith(match.field.startsWith)) return false;
  }
  return true;
}

function createEngine({ rules = [], handlers = {} } = {}) {
  return {
    respond(parsed, session) {
      const rule = rules.find((r) => matches(r.match, parsed));
      if (!rule) return { payload: null, rule: null };
      if (rule.noReply === true) return { payload: null, rule: rule.name };
      const ctx = {
        luno: (session && session.luno) || parsed.luno || '',
        tvn: session ? String(session.tvn) : '0',
      };
      if (rule.handler != null) {
        const fn = handlers[rule.handler];
        if (typeof fn !== 'function') {
          throw new Error(`Rule "${rule.name}" references unknown handler "${rule.handler}"`);
        }
        return { payload: fn(parsed, session, { applyTemplate, ctx, constants }), rule: rule.name };
      }
      if (rule.template != null) return { payload: applyTemplate(rule.template, ctx), rule: rule.name };
      return { payload: null, rule: rule.name };
    },
  };
}

module.exports = { applyTemplate, matches, createEngine };
```

- [ ] **Step 4: 运行测试确认通过**

Run: `node --test test/engine.test.js`
Expected: PASS（6 tests）

- [ ] **Step 5: 提交**

```bash
git add src/engine.js test/engine.test.js
git commit -m "feat: add hybrid response engine (rules + templates + handlers)"
```

---

### Task 7: handler —— Go-In-Service 示例

**Files:**
- Create: `src/handlers/goInService.js`
- Create: `test/goInService.test.js`

**Interfaces:**
- Consumes: engine 的 handler 签名 `(parsed, session, helpers) => string|null`（Task 6）
- Produces: `src/handlers/goInService.js` —— 默认导出一个 handler 函数，返回 Go-In-Service 终端命令 `1<FS><FS><FS>1`（class `1`=TerminalCommand，命令码 `1`=go-in-service）。返回前调用 `session.remember(parsed)` 记住 LUNO。

- [ ] **Step 1: 写失败测试**

Create `test/goInService.test.js`:

```js
const test = require('node:test');
const assert = require('node:assert');
const goInService = require('../src/handlers/goInService');
const { applyTemplate } = require('../src/engine');
const constants = require('../src/constants');
const { FS } = constants;
const { parse } = require('../src/ndc/parser');
const { encodeText } = require('../src/framing');
const { createSession } = require('../src/session');

test('goInService returns "1<FS><FS><FS>1" terminal command', () => {
  const p = parse(encodeText('22' + FS + '123' + FS + FS + 'B0000'));
  const session = createSession();
  const out = goInService(p, session, { applyTemplate, ctx: { luno: '123', tvn: '0' }, constants });
  assert.strictEqual(out, '1' + FS + FS + FS + '1');
  assert.strictEqual(session.luno, '123'); // 记住了 LUNO
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `node --test test/goInService.test.js`
Expected: FAIL —— `Cannot find module '../src/handlers/goInService'`

- [ ] **Step 3: 实现 goInService.js**

Create `src/handlers/goInService.js`:

```js
// Go-In-Service terminal command: class '1' (TerminalCommand), command code '1'.
// 结构: "1" + FS + <空 LUNO 字段> + FS + <空字段> + FS + "1"
module.exports = function goInService(parsed, session, helpers) {
  if (session) session.remember(parsed);
  return helpers.applyTemplate('1<FS><FS><FS>1', helpers.ctx);
};
```

- [ ] **Step 4: 运行测试确认通过**

Run: `node --test test/goInService.test.js`
Expected: PASS（1 test）

- [ ] **Step 5: 提交**

```bash
git add src/handlers/goInService.js test/goInService.test.js
git commit -m "feat: add go-in-service terminal command handler"
```

---

### Task 8: logging —— hex dump + 落盘录包

**Files:**
- Create: `src/logging.js`
- Create: `test/logging.test.js`

**Interfaces:**
- Consumes: 无（不依赖其他 src 模块，保持独立可测）
- Produces: `src/logging.js` 导出
  - `hexDump(buf: Buffer): string` —— 每行 16 字节，格式 `<8位十六进制偏移>  <hex 空格分隔>  |<可打印 ASCII，非可打印用 '.'>|`
  - `createLogger({ dir, now }): Logger`
    - `dir`：录包目录；`now`：可选的返回 Date 的函数（测试注入，默认 `() => new Date()`）
    - `Logger.record(direction: 'RECV'|'SEND', buf: Buffer, meta?: object): void` —— 打印到 console 并追加写入 `dir/session-<ISO时间戳>.log`（首次 record 时确定文件名）。meta 里可含 `{ type, rule }`。
    - `Logger.file: string` —— 当前录包文件绝对路径（首次 record 后可读）

- [ ] **Step 1: 写失败测试**

Create `test/logging.test.js`:

```js
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { hexDump, createLogger } = require('../src/logging');

test('hexDump formats offset, hex and ascii', () => {
  const out = hexDump(Buffer.from('AB' + String.fromCharCode(0x1c), 'latin1'));
  assert.match(out, /^00000000\s+41 42 1c/);
  assert.match(out, /\|AB\.\|/); // 0x1c 不可打印 → '.'
});

test('record writes hex capture to a file', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ndc-cap-'));
  const logger = createLogger({ dir, now: () => new Date('2026-07-05T00:00:00Z') });
  logger.record('RECV', Buffer.from('22', 'latin1'), { type: 'SolicitedStatus', rule: 'gis' });
  const content = fs.readFileSync(logger.file, 'utf8');
  assert.match(content, /RECV/);
  assert.match(content, /SolicitedStatus/);
  assert.match(content, /32 32/); // "22" 的 hex
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `node --test test/logging.test.js`
Expected: FAIL —— `Cannot find module '../src/logging'`

- [ ] **Step 3: 实现 logging.js**

Create `src/logging.js`:

```js
const fs = require('node:fs');
const path = require('node:path');

function hexDump(buf) {
  const lines = [];
  for (let i = 0; i < buf.length; i += 16) {
    const slice = buf.subarray(i, i + 16);
    const offset = i.toString(16).padStart(8, '0');
    const hex = [...slice].map((b) => b.toString(16).padStart(2, '0')).join(' ');
    const ascii = [...slice].map((b) => (b >= 0x20 && b < 0x7f ? String.fromCharCode(b) : '.')).join('');
    lines.push(`${offset}  ${hex.padEnd(16 * 3 - 1)}  |${ascii}|`);
  }
  return lines.join('\n');
}

function createLogger({ dir, now = () => new Date() } = {}) {
  let file = null;
  function ensureFile() {
    if (file) return file;
    fs.mkdirSync(dir, { recursive: true });
    const stamp = now().toISOString().replace(/[:.]/g, '-');
    file = path.join(dir, `session-${stamp}.log`);
    return file;
  }
  const logger = {
    get file() {
      return file;
    },
    record(direction, buf, meta = {}) {
      const f = ensureFile();
      const ts = now().toISOString();
      const header = `[${ts}] ${direction} ${meta.type || ''} rule=${meta.rule || '-'} (${buf.length} bytes)`;
      const block = `${header}\n${hexDump(buf)}\n`;
      console.log(block);
      fs.appendFileSync(f, block + '\n');
    },
  };
  return logger;
}

module.exports = { hexDump, createLogger };
```

- [ ] **Step 4: 运行测试确认通过**

Run: `node --test test/logging.test.js`
Expected: PASS（2 tests）

- [ ] **Step 5: 提交**

```bash
git add src/logging.js test/logging.test.js
git commit -m "feat: add hex-dump logging with packet capture to file"
```

---

### Task 9: transport —— TCP + TLS 服务器

**Files:**
- Create: `src/transport.js`
- Create: `test/transport.test.js`

**Interfaces:**
- Consumes: `config`（`{ port, enableTLS, tls:{key,cert} }`）
- Produces: `src/transport.js` 导出
  - `createTransport(config, onConnection: (socket) => void): net.Server | tls.Server`
    - `config.enableTLS !== true` → `net.createServer`；否则 `tls.createServer`，强制 `minVersion/maxVersion = 'TLSv1.2'`，读 `config.tls.key`/`cert`，缺失则 `throw new Error(...)`。
    - 每个连接调用 `onConnection(socket)`。
    - 返回未 `listen` 的 server（由 server.js 决定何时 `listen`）。

- [ ] **Step 1: 写失败测试**

Create `test/transport.test.js`:

```js
const test = require('node:test');
const assert = require('node:assert');
const net = require('node:net');
const { createTransport } = require('../src/transport');

test('TLS enabled without certs throws', () => {
  assert.throws(() => createTransport({ enableTLS: true, tls: {} }, () => {}), /certificate/i);
});

test('TCP server invokes onConnection and can echo', async () => {
  const received = [];
  const server = createTransport({ enableTLS: false }, (socket) => {
    socket.on('data', (d) => {
      received.push(d);
      socket.write(d); // echo
    });
  });
  await new Promise((resolve) => server.listen(0, resolve));
  const port = server.address().port;

  const echoed = await new Promise((resolve, reject) => {
    const client = net.createConnection({ port }, () => client.write(Buffer.from([1, 2, 3])));
    client.on('data', (d) => {
      resolve(d);
      client.end();
    });
    client.on('error', reject);
  });
  assert.deepStrictEqual([...echoed], [1, 2, 3]);
  assert.strictEqual(received.length, 1);
  await new Promise((resolve) => server.close(resolve));
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `node --test test/transport.test.js`
Expected: FAIL —— `Cannot find module '../src/transport'`

- [ ] **Step 3: 实现 transport.js**

Create `src/transport.js`:

```js
const net = require('node:net');
const tls = require('node:tls');
const fs = require('node:fs');

function createTransport(config, onConnection) {
  if (config.enableTLS === true) {
    if (!config.tls || !config.tls.key || !config.tls.cert) {
      throw new Error('TLS enabled but certificate/key not configured in config.tls');
    }
    const options = {
      key: fs.readFileSync(config.tls.key),
      cert: fs.readFileSync(config.tls.cert),
      minVersion: 'TLSv1.2',
      maxVersion: 'TLSv1.2',
    };
    return tls.createServer(options, onConnection);
  }
  return net.createServer(onConnection);
}

module.exports = { createTransport };
```

- [ ] **Step 4: 运行测试确认通过**

Run: `node --test test/transport.test.js`
Expected: PASS（2 tests）

- [ ] **Step 5: 提交**

```bash
git add src/transport.js test/transport.test.js
git commit -m "feat: add TCP/TLS transport factory"
```

---

### Task 10: 装配 server.js + 迁移 config.json + 端到端测试 + README

**Files:**
- Modify: `server.js`（整文件重写为装配层）
- Modify: `config.json`（`messageMapping` → `rules`，加 `responseDelayMs`）
- Modify: `README.md`（与新代码/配置对齐）
- Create: `test/e2e.test.js`

**Interfaces:**
- Consumes: 以上所有 src 模块
- Produces: `server.js` 导出 `createApp(config): { server, start(port) }` 以便端到端测试可用；同时保留 `require.main === module` 时直接启动的行为。
  - `createApp` 装配：每个连接建 `createSession()` + `createDecoder()`；`data` 事件 → 拆帧 → 逐帧 `parse` → `session.remember` → `engine.respond` 得 `{payload, rule}` → `logger.record('RECV', ..., {rule})` → 分三种情况：`rule==null`（未识别）告警不回写；`payload==null`（匹配到 noReply，如 ReadyB 心跳）静默不回写；否则 `logger.record('SEND', ...)` 后延迟 `config.responseDelayMs`（默认 0）`socket.write(encodeLength(encodeText(payload)))`。

- [ ] **Step 1: 写失败的端到端测试**

Create `test/e2e.test.js`:

```js
const test = require('node:test');
const assert = require('node:assert');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');
const { createApp } = require('../server');
const { FS } = require('../src/constants');
const { encodeLength, createDecoder } = require('../src/framing');

test('ATM solicited status gets a Go-In-Service reply end-to-end', async () => {
  const capDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ndc-e2e-'));
  const app = createApp({
    enableTLS: false,
    responseDelayMs: 0,
    captureDir: capDir,
    rules: [{ name: 'ready9-go-in-service', match: { messageClass: '2', field: { index: 3, startsWith: '9' } }, handler: 'goInService' }],
  });
  await new Promise((resolve) => app.server.listen(0, resolve));
  const port = app.server.address().port;

  const reply = await new Promise((resolve, reject) => {
    const decoder = createDecoder();
    const client = net.createConnection({ port }, () => {
      client.write(encodeLength(Buffer.from('22' + FS + '123' + FS + FS + '9', 'latin1')));
    });
    client.on('data', (d) => {
      const frames = decoder.push(d);
      if (frames.length) {
        resolve(frames[0].toString('latin1'));
        client.end();
      }
    });
    client.on('error', reject);
  });

  assert.strictEqual(reply, '1' + FS + FS + FS + '1');
  await new Promise((resolve) => app.server.close(resolve));
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `node --test test/e2e.test.js`
Expected: FAIL —— `createApp is not a function`（或 server.js 旧内容报错）

- [ ] **Step 3: 重写 server.js 为装配层**

用以下内容整体替换 `server.js`：

```js
const path = require('node:path');
const fs = require('node:fs');

const { createTransport } = require('./src/transport');
const { createDecoder, encodeLength, encodeText } = require('./src/framing');
const { parse } = require('./src/ndc/parser');
const { createSession } = require('./src/session');
const { createEngine } = require('./src/engine');
const { createLogger } = require('./src/logging');
const goInService = require('./src/handlers/goInService');

const handlers = { goInService };

function createApp(config) {
  const captureDir = config.captureDir || path.join(__dirname, 'captures');
  const responseDelayMs = config.responseDelayMs || 0;
  const engine = createEngine({ rules: config.rules || [], handlers });
  const logger = createLogger({ dir: captureDir });

  const server = createTransport(config, (socket) => {
    const peer = `${socket.remoteAddress}:${socket.remotePort}`;
    console.log(`Client connected from ${peer}`);
    const session = createSession();
    const decoder = createDecoder();

    socket.on('data', (chunk) => {
      let frames;
      try {
        frames = decoder.push(chunk);
      } catch (err) {
        console.error(`Framing error from ${peer}: ${err.message}`);
        return;
      }
      for (const payload of frames) {
        const parsed = parse(payload);
        session.remember(parsed);
        let result = { payload: null, rule: null };
        try {
          result = engine.respond(parsed, session);
        } catch (err) {
          console.error(`Engine error: ${err.message}`);
        }
        logger.record('RECV', payload, {
          type: parsed.type,
          rule: result.rule == null ? 'UNMATCHED' : result.rule,
        });
        if (result.rule == null) {
          // 真正未识别：完整 hex 已录，明确告警，不静默丢弃
          console.error(`No rule matched for ${parsed.type} — see capture for full hex`);
          continue;
        }
        if (result.payload == null) {
          // 匹配到 noReply 规则（如 ReadyB 心跳/设备状态）：正常无应答，不告警
          continue;
        }
        const bytes = encodeText(result.payload);
        logger.record('SEND', bytes, { type: parsed.type, rule: result.rule });
        const out = encodeLength(bytes);
        setTimeout(() => {
          if (!socket.destroyed) socket.write(out);
        }, responseDelayMs);
      }
    });

    socket.on('end', () => console.log(`Client disconnected: ${peer}`));
    socket.on('error', (err) => console.error(`Socket error ${peer}: ${err.message}`));
  });

  server.on('error', (err) => console.error(`Server error: ${err.message}`));

  return {
    server,
    start(port) {
      server.listen(port, () => console.log(`NDC host simulator listening on port ${port}`));
      return server;
    },
  };
}

if (require.main === module) {
  const config = JSON.parse(fs.readFileSync(path.join(__dirname, 'config.json'), 'utf8'));
  const port = config.port || 2000;
  const mode = config.enableTLS ? 'TLS 1.2' : 'TCP';
  console.log(`Starting ${mode} server on port ${port}...`);
  createApp(config).start(port);
}

module.exports = { createApp };
```

- [ ] **Step 4: 运行端到端测试确认通过**

Run: `node --test test/e2e.test.js`
Expected: PASS（1 test）

- [ ] **Step 5: 迁移 config.json**

用以下内容整体替换 `config.json`。规则依据 AJMN1301 真实抓包的主机行为：Ready9 回
go-in-service；ReadyB 心跳、TerminalState(F)、设备状态(12) 主机不应答（`noReply`）。
（TransactionRequest→TransactionReply 属子项目 2，此处不含。）

```json
{
  "port": 2000,
  "enableTLS": false,
  "responseDelayMs": 0,
  "tls": {
    "key": "path/to/key.pem",
    "cert": "path/to/cert.pem"
  },
  "rules": [
    {
      "name": "ready9-go-in-service",
      "match": { "messageClass": "2", "field": { "index": 3, "startsWith": "9" } },
      "handler": "goInService"
    },
    {
      "name": "ready-b-idle-no-reply",
      "match": { "messageClass": "2", "field": { "index": 3, "startsWith": "B" } },
      "noReply": true
    },
    {
      "name": "terminal-state-no-reply",
      "match": { "messageClass": "2", "field": { "index": 3, "startsWith": "F" } },
      "noReply": true
    },
    {
      "name": "unsolicited-status-no-reply",
      "match": { "messageClass": "1", "subClass": "2" },
      "noReply": true
    }
  ]
}
```

- [ ] **Step 6: 跑全部测试确认无回归**

Run: `node --test`
Expected: PASS（全部 test 文件通过）

- [ ] **Step 7: 更新 README.md**

用以下内容整体替换 `README.md`：

````markdown
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
    { "name": "solicited-status-go-in-service",
      "match": { "messageClass": "2" },
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
> 对 ReadyB(`B`)/TerminalState(`F`)/设备状态(`12`) 不应答。TransactionRequest→TransactionReply
> 属后续子项目，默认配置暂不含。

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
````

- [ ] **Step 8: 更新 .gitignore 忽略录包内容**

确认 `.gitignore` 中包含 `captures/*.log`（若无则追加一行 `captures/*.log`，保留 `captures/.gitkeep` 被跟踪）。

- [ ] **Step 9: 提交**

```bash
git add server.js config.json README.md test/e2e.test.js .gitignore
git commit -m "feat: wire modular NDC host simulator with config migration and e2e test"
```

---

## Self-Review 结果

**Spec 覆盖检查**（对照 `2026-07-05-ndc-host-simulator-design.md`）：

- §3.1 transport → Task 9 ✅
- §3.1 framing（分帧 + 缓冲拆帧 + win-1252/latin1 编解码）→ Task 2、3 ✅（编解码用 latin1，Global Constraints 已说明理由，替代 spec 里 win-1252 的模糊点）
- §3.1 ndc/parser（解析 + classify + 保留空字段）→ Task 4 ✅
- §3.1 engine（混合式：规则匹配 + 占位符 + handler + noReply）→ Task 6 ✅（新增 `noReply` 一等公民 + `respond` 返回 `{payload,rule}`，依据真实抓包区分"匹配到但不回"与"未识别"）
- §3.1 session → Task 5 ✅
- §3.1 logging（hex dump + 录包 + 可配置延迟）→ Task 8（延迟在 Task 10 装配处接入 `responseDelayMs`）✅
- §3.1 handlers/goInService → Task 7 ✅
- §3.2 数据流 → Task 10 装配 ✅
- §4 config.json（rules 取代 messageMapping、responseDelayMs）→ Task 10 ✅
- §5 错误处理（未识别不静默丢弃、TLS 证书缺失报错、socket error 清理）→ Task 4/9/10 ✅
- §6 测试策略（framing 粘/半包、parser 真实样本、engine、端到端）→ Task 2/4/6/10 ✅
- §7 构建顺序 → Task 1→10 顺序一致 ✅
- §8 非目标（完整交易流程、MAC 生成、EBCDIC、host 主动连接）→ 均未纳入，`mac` 仅占位 ✅

**占位符扫描**：无 TBD/TODO/“略”，每个代码步骤均给出完整代码。

**类型一致性**：`ParsedMessage` 形状（Task 4 产出）在 Task 6/7/10 消费一致；`createEngine({rules,handlers})`、`respond(parsed,session)`、handler 签名 `(parsed,session,helpers)`、`applyTemplate(template,ctx)`、`createDecoder().push`、`encodeLength`/`encodeText`、`createLogger({dir,now}).record(direction,buf,meta)` 各处签名一致。

无遗留问题。
