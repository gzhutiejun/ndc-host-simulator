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
//   POST /api/push       立刻给所有活跃连接下发一条终端命令，不等 ATM 先发请求

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { URL } = require('node:url');
const { describe } = require('./message-library');
const { decodeWire } = require('./framing');
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
function createUiServer({ engine, library = [], push } = {}) {
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
    const frame = {
      direction, // 'RECV' | 'SEND'
      bytes: buf.length,
      text,
      fields,
      type: meta.type || null,
      rule: meta.rule || null,
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
    if (!body || typeof body.code !== 'string' || body.code === '') {
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

module.exports = { createUiServer, toVisible, decodeFrame };
