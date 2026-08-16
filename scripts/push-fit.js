#!/usr/bin/env node
// 命令行下发一条 FIT（`npm run push-fit`）。
//
// 只是往模拟器的浏览器控制台接口打一发 `POST /api/push {"type":"fit"}`——报文内容全部来自
// config.json 的 fitDownload，这里不重复一份拼装逻辑。所以要先把模拟器跑起来，且 config.json
// 里配了 uiPort（不配控制台压根不启动，这个脚本也就无处可打）。
//
//   node scripts/push-fit.js              # 端口取 config.json 的 uiPort
//   node scripts/push-fit.js --port 8080  # 就地指定控制台端口
//
// FIT 只会发给**当前已连上**的 ATM；一台没连时返回 {"sent":0}，脚本照样以 0 退出并把
// 这个数字打出来——"没人在线"不是错误，是事实。

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

function parseArgs(argv) {
  const opts = {};
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--port') {
      opts.port = argv[i + 1];
      i += 1;
    }
  }
  return opts;
}

function resolvePort(opts) {
  if (opts.port) return Number(opts.port);
  const configPath = path.join(__dirname, '..', 'config.json');
  const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  if (!config.uiPort) {
    throw new Error(`config.json 里没配 uiPort，控制台没有启动；用 --port 指定，或先配上 uiPort`);
  }
  return config.uiPort;
}

function postFit(port) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify({ type: 'fit' });
    const req = http.request(
      {
        port,
        method: 'POST',
        path: '/api/push',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) },
      },
      (res) => {
        let raw = '';
        res.on('data', (chunk) => { raw += chunk; });
        res.on('end', () => resolve({ status: res.statusCode, body: raw }));
      },
    );
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

async function main() {
  const port = resolvePort(parseArgs(process.argv.slice(2)));
  const res = await postFit(port);
  if (res.status !== 200) {
    throw new Error(`控制台返回 ${res.status}: ${res.body}`);
  }
  const sent = JSON.parse(res.body).sent;
  console.log(`FIT 已下发给 ${sent} 个活跃连接`);
}

main().catch((err) => {
  // 连接类错误（ECONNREFUSED 等）的 err.message 常常是空串，只印它等于什么都没说，
  // 所以退回到 err.code、再退回到整个对象。
  const reason = err.message || err.code || String(err);
  console.error(`push-fit failed: ${reason}（模拟器起来了吗？config.json 里配 uiPort 了吗？）`);
  process.exitCode = 1;
});
