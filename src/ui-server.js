// HTTP 控制台（Task 3）：给测试的人一个能看、能点的界面，不用重启模拟器就能换下一条应答。
//
// 只用 Node 内置模块（http/fs/path/url），零依赖，跟仓库其它地方口径一致。这个模块本身
// 只负责"建一个 http.Server 并接好路由"——要不要真的监听端口，由 server.js 按
// config.uiPort 决定（未配置/为 0 时 server.js 根本不会调用这个模块，见 server.js 里的
// `config.uiPort ? createUiServer(...) : null`）。
//
// 五个端点：
//   GET  /             控制台页面（src/ui/index.html，内联 CSS/JS，单文件）
//   GET  /api/library   报文库列表：[{key, label, messageClass, subClass}]（不带 fields/payload，
//                        选中后靠 key 让 engine 去查，不用把 602 字节的载荷都传一遍）
//   GET  /api/stream     SSE，收发的每一帧推一条 `data: {...}\n\n`
//   POST /api/next       设置/撤销一次性覆盖，body 就是 engine.setNextResponse() 的参数
//   POST /api/push       立刻给所有活跃连接下发一条报文，不等 ATM 先发请求。
//                        {code, modifier, luno, msn} → 类 1 终端命令（默认）
//                        {type:"fit", ...}           → 类 3 FIT 下发，缺省字段取 config.fitDownload
//                        {type:"emv", subclass, data, luno} → 报文类 8 EMV 配置命令，缺 subclass 400
//                        {type:"data", identifier, data, luno, msn} → 类 3 数据命令（如 3/1 A 增强选项），缺 identifier 400

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { URL } = require('node:url');
const { describe } = require('./message-library');
const { decodeWire } = require('./framing');
const { extractLts, extractCam } = require('./ndc/transactionRequest');
const { HEX_32, HEX_16_OR_32 } = require('./ndc/eki');
const { FS, GS, RS, SO, SI } = require('./constants');

const INDEX_HTML_PATH = path.join(__dirname, 'ui', 'index.html');

// 控制字符 → 可见符号。直接从 constants.js 取值当 key，不在这里重新拼字节值——
// plan 文档本身订正过一次 SO/SI（早期版本写反过），这里不重蹈覆辙：谁是 SO/SI
// 完全由 constants.js 说了算，这个模块只管映射到什么符号。
const VISIBLE_SYMBOL = new Map([
  [FS, '|'],
  [GS, '~'],
  [RS, '^'],
  [SO, '<'],
  [SI, '>'],
]);

function toVisible(text) {
  let out = '';
  for (const ch of text) out += VISIBLE_SYMBOL.get(ch) || ch;
  return out;
}

function decodeFrame(buf) {
  // 控制台展示的是线缆上的帧，按传输码换码；不换的话 EBCDIC 配置下页面全是乱码。
  const text = decodeWire(buf);
  const fields = text.split(FS).map(toVisible);
  return { text: toVisible(text), fields };
}

/**
 * 8b：状态报文（报文类 2）里的 CAM 回报尾与 DIG c。入参是**原始**字段（GS 未换成可见符号）。
 *   ready       Ready 描述符（`9`/`B`）后 GS 之后的原文
 *   deviceFault 设备故障（字段 3 = `8`）后面字段里第一个 GS 之后的原文
 *   digC        字段 3 = `8` 且字段 4 以 `c` 开头
 * 都没有 -> undefined。展示用，值已转可见符号。
 */
function extractStatusTails(fields) {
  if (!fields[0] || fields[0][0] !== '2') return undefined;
  const f3 = fields[3] || '';
  const out = {};
  const after = (text) => {
    const i = text.indexOf(GS);
    return i >= 0 ? toVisible(text.slice(i + 1)) : undefined;
  };
  if (f3[0] === '9' || f3[0] === 'B') {
    const t = after(f3);
    if (t !== undefined) out.ready = t;
  } else if (f3[0] === '8') {
    for (let i = 4; i < fields.length; i += 1) {
      const t = after(fields[i] || '');
      if (t !== undefined) { out.deviceFault = t; break; }
    }
    if ((fields[4] || '').startsWith('c')) out.digC = true;
  }
  return Object.keys(out).length ? out : undefined;
}

/**
 * 8c-1：ATM 对主机密钥命令（EKI）的回复与 MAC 加密机错误。入参是原始字段。
 *   23 … 3 FS kvv        新键 KVV
 *   23 … 4 FS x24        四段 KVV（主 / 通讯 / MAC / B，各 6 位 hex）
 *   22 … C FS 码         reject 码
 *   12 … L1              加密机错误（MAC）
 * 都不是 -> undefined。
 */
function extractEkiStatus(fields) {
  const head = fields[0] || '';
  if (head[0] === '2' && head[1] === '3') {
    if (fields[3] === '3') return { kind: 'newKeyKvv', kvv: fields[4] || '' };
    if (fields[3] === '4' && (fields[4] || '').length === 24) {
      const v = fields[4];
      return { kind: 'allKvvs', master: v.slice(0, 6), comms: v.slice(6, 12), mac: v.slice(12, 18), b: v.slice(18, 24) };
    }
    return undefined;
  }
  if (head[0] === '2' && head[1] === '2' && fields[3] === 'C') {
    return { kind: 'reject', code: fields[4] || '' };
  }
  if (head === '12' && fields[3] === 'L1') return { kind: 'encryptorMacError' };
  return undefined;
}

function sendJson(res, status, body) {
  const data = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(data, 'utf8'),
  });
  res.end(data);
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk) => {
      data += chunk;
      if (data.length > 1e6) {
        reject(new Error('request body too large'));
        req.destroy();
      }
    });
    req.on('end', () => {
      if (!data.trim()) return resolve(null); // 空 body：{key}/{payload} 都没给，走 null（撤销覆盖）
      try {
        resolve(JSON.parse(data));
      } catch (err) {
        reject(new Error(`invalid JSON body: ${err.message}`));
      }
    });
    req.on('error', reject);
  });
}

/**
 * @param {object} opts
 * @param {object} opts.engine       Task 2 的 engine 实例（要有 setNextResponse）
 * @param {Array<{key:string,payload:string}>} [opts.library] Task 1 parseLibrary() 的结果
 * @param {(spec: object) => {sent: number}} [opts.push] 立刻下发终端命令的回调，由 server.js
 *   注入（它才知道当前有哪些活跃 socket）；不传时 POST /api/push 返回 503。
 */
function createUiServer({ engine, library = [], push, ekiMasterKey = '' } = {}) {
  if (!engine || typeof engine.setNextResponse !== 'function') {
    throw new Error('createUiServer: engine with setNextResponse(...) is required');
  }

  // 库是静态的（起服务时读一次，运行中不变），标签在这里算一次，不必每次请求都重算
  // 1000+ 条 describe()。 特意不带 fields/payload：选中靠 key 让 engine 去库里查，
  // 页面不需要提前拿到原始载荷。
  const libraryList = library.map(({ key, payload }) => {
    const info = describe(payload);
    return { key, label: info.label, messageClass: info.messageClass, subClass: info.subClass };
  });

  const sseClients = new Set();

  function publish(direction, buf, meta = {}) {
    if (sseClients.size === 0) return; // 没人在看，省得白解码
    const { text, fields } = decodeFrame(buf);
    // 请求流里把 Last Transaction Status（2 段）解出来显示；只对 ATM→主机的帧有意义。
    // GS 在 decodeFrame 的 fields 里已被换成可见符号，所以 LTS 的 camTail / 状态尾要从原始字段取。
    const rawFields = direction === 'RECV' ? decodeWire(buf).split(FS) : null;
    const lts = rawFields ? extractLts(rawFields) : undefined;
    if (lts) {
      lts.raw = toVisible(lts.raw);
      if (lts.camTail !== undefined) lts.camTail = toVisible(lts.camTail);
    }
    const cam = rawFields ? extractCam(rawFields) : undefined;
    const tails = rawFields ? extractStatusTails(rawFields) : undefined;
    const eki = rawFields ? extractEkiStatus(rawFields) : undefined;
    const frame = {
      direction, // 'RECV' | 'SEND'
      bytes: buf.length,
      text,
      fields,
      type: meta.type || null,
      rule: meta.rule || null,
      lts: lts || null,
      cam: cam || null,
      tails: tails || null,
      eki: eki || null,
      ts: Date.now(),
    };
    const line = `data: ${JSON.stringify(frame)}\n\n`;
    for (const res of sseClients) {
      try {
        res.write(line);
      } catch {
        sseClients.delete(res);
      }
    }
  }

  function serveIndex(res) {
    fs.readFile(INDEX_HTML_PATH, (err, data) => {
      if (err) {
        res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end(`ui/index.html unavailable: ${err.message}`);
        return;
      }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(data);
    });
  }

  function serveLibrary(res) {
    sendJson(res, 200, { count: libraryList.length, entries: libraryList });
  }

  function serveStream(req, res) {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });
    res.write(':connected\n\n'); // SSE 注释行：让客户端立刻拿到响应头，也是个探活行
    sseClients.add(res);
    req.on('close', () => sseClients.delete(res));
  }

  async function handleNext(req, res) {
    let body;
    try {
      body = await readJsonBody(req);
    } catch (err) {
      sendJson(res, 400, { error: err.message });
      return;
    }
    try {
      engine.setNextResponse(body);
      sendJson(res, 200, { armed: body });
    } catch (err) {
      sendJson(res, 400, { error: err.message });
    }
  }

  async function handlePush(req, res) {
    if (typeof push !== 'function') {
      sendJson(res, 503, { error: 'push handler not wired up' });
      return;
    }
    let body;
    try {
      body = await readJsonBody(req);
    } catch (err) {
      sendJson(res, 400, { error: err.message });
      return;
    }
    // 这里只做"能不能发"的门卫，不管报文长什么样：怎么拼字节是注入的 push 回调
    // （server.js 的 pushToActiveSockets）的事。
    //   不带 type / type='command' —— 类 1 终端命令，必须有 code（老契约，逐字节不变）
    //   type='fit'                 —— FIT 下发，报文类 3，没有 code 这个概念
    //   type='data'                —— 通用数据命令，报文类 3，必须有 identifier（报文标识）
    //   type='emv'                 —— EMV 配置命令，报文类 8，必须有 subclass
    //   type='eki'                 —— 主机密钥命令，报文类 3 子类 3/4，masterKey 缺省取配置 eki.masterKey
    const type = body && body.type != null ? body.type : 'command';
    if (type !== 'command' && type !== 'fit' && type !== 'data' && type !== 'emv' && type !== 'eki') {
      sendJson(res, 400, { error: `push: unknown type "${type}" (expected "command", "fit", "data", "emv" or "eki")` });
      return;
    }
    if (type === 'data' && (!body || typeof body.identifier !== 'string' || body.identifier === '')) {
      sendJson(res, 400, { error: 'push type=data requires a non-empty "identifier"' });
      return;
    }
    if (type === 'eki') {
      const masterKey = body.masterKey != null ? body.masterKey : ekiMasterKey;
      if (typeof masterKey !== 'string' || !HEX_32.test(masterKey)) {
        sendJson(res, 400, { error: 'push type=eki requires masterKey (32 hex) in the body or config eki.masterKey' });
        return;
      }
      if (typeof body.newKey !== 'string' || !HEX_16_OR_32.test(body.newKey)) {
        sendJson(res, 400, { error: 'push type=eki requires newKey (16 or 32 hex)' });
        return;
      }
      body = { ...body, masterKey };
    }
    if (type === 'emv' && (!body || typeof body.subclass !== 'string' || body.subclass === '')) {
      sendJson(res, 400, { error: 'push type=emv requires a non-empty "subclass"' });
      return;
    }
    if (type === 'command' && (!body || typeof body.code !== 'string' || body.code === '')) {
      sendJson(res, 400, { error: 'push requires a non-empty "code"' });
      return;
    }
    try {
      const result = push(body);
      sendJson(res, 200, result);
    } catch (err) {
      sendJson(res, 400, { error: err.message });
    }
  }

  function requestListener(req, res) {
    const url = new URL(req.url, 'http://localhost');
    if (req.method === 'GET' && url.pathname === '/') return serveIndex(res);
    if (req.method === 'GET' && url.pathname === '/api/library') return serveLibrary(res);
    if (req.method === 'GET' && url.pathname === '/api/stream') return serveStream(req, res);
    if (req.method === 'POST' && url.pathname === '/api/next') return handleNext(req, res);
    if (req.method === 'POST' && url.pathname === '/api/push') return handlePush(req, res);
    sendJson(res, 404, { error: `no route for ${req.method} ${url.pathname}` });
  }

  const server = http.createServer(requestListener);

  return {
    server,
    publish,
    listen(port, cb) {
      return server.listen(port, cb);
    },
    close(cb) {
      for (const res of sseClients) res.end();
      sseClients.clear();
      return server.close(cb);
    },
  };
}

module.exports = { createUiServer, toVisible, decodeFrame, extractStatusTails, extractEkiStatus };
