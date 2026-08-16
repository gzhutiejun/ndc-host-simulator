const test = require('node:test');
const assert = require('node:assert');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');
const { execFile } = require('node:child_process');
const { createApp } = require('../server');
const { FS } = require('../src/constants');
const { createDecoder } = require('../src/framing');

const SCRIPT = path.join(__dirname, '..', 'scripts', 'push-fit.js');

const FIT_ENTRY = '023000255255255255255002000132000015000031138255007001035069103137001035069'
  + '000000000000000000000000064064064000000000';
const EXPECTED_FIT_FRAME = '30' + FS + '218' + FS + '000' + FS + '15' + FS + FIT_ENTRY + FS;

function run(args) {
  return new Promise((resolve) => {
    execFile(process.execPath, [SCRIPT].concat(args), (err, stdout, stderr) => {
      resolve({ code: err ? err.code : 0, stdout, stderr });
    });
  });
}

test('npm 脚本 push-fit：--port 指向控制台端口，FIT 帧真的到达 ATM 连接', async () => {
  const capDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ndc-cli-fit-'));
  const app = createApp({
    enableTLS: false,
    captureDir: capDir,
    rules: [],
    uiPort: 1,
    fitDownload: { luno: '218', msn: '000', responseFlag: '0', entries: [FIT_ENTRY] },
  });
  await new Promise((r) => app.server.listen(0, r));
  await new Promise((r) => app.ui.listen(0, r));

  const decoder = createDecoder();
  const client = net.createConnection({ port: app.server.address().port });
  await new Promise((resolve, reject) => { client.on('connect', resolve); client.on('error', reject); });
  const pushed = new Promise((resolve) => {
    client.on('data', (d) => {
      const frames = decoder.push(d);
      if (frames.length) resolve(frames[0].toString('latin1'));
    });
  });

  try {
    const res = await run(['--port', String(app.ui.server.address().port)]);
    assert.strictEqual(res.code, 0, `脚本应当以 0 退出，stderr: ${res.stderr}`);
    assert.strictEqual(await pushed, EXPECTED_FIT_FRAME);
  } finally {
    client.destroy();
    await new Promise((r) => app.server.close(r));
    await new Promise((r) => app.ui.close(r));
  }
});

test('npm 脚本 push-fit：控制台端口上没人监听时非 0 退出，并把原因写到 stderr', async () => {
  // 端口 1 在非 root 下必定连不上，用它当"确定连不通"的地址
  const res = await run(['--port', '1']);
  assert.notStrictEqual(res.code, 0);
  // 匹配脚本自己写的这句，而不是路径里恰好也有 "push-fit" 的堆栈——脚本不存在时
  // node 的 MODULE_NOT_FOUND 也会带上路径，那样这条用例会因为错误的理由通过。
  // 而且原因必须说得出口：连接错误的 err.message 是空串，光印一句 "push-fit failed: "
  // 等于没说，所以这里钉住"冒号后面有内容"。
  assert.match(res.stderr, /push-fit failed: \S/);
});
