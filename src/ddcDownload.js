const fs = require('node:fs');
const { FS, GS } = require('./constants');

/**
 * CUBC 主机（D912）的整套下载，照现网（acc-cubc docs/cubc/host-messages.md §5.5）：
 * 终端发上电 `12…1` 或出主管 `12…300` 之后，主机逐条下发 换通讯密钥 → 配置参数 → 状态表 → 屏幕 → FIT →
 * EMV 配置 → 配置 ID → `10 3`（送配置信息）→ `10 ;`（送增强计数），每条都等终端回一条 `22…` 再发下一条；
 * 最后看计数：钞箱状态 `@@@@`（全不可用）时发 `10 2` 让终端留在服务外，否则 `10 1` 进服务。
 */

const RS = '\x1e';
const TOKENS = {
  '<FS>': FS, '<GS>': GS, '<RS>': RS, '<US>': '\x1f', '<ESC>': '\x1b',
  '<SI>': '\x0f', '<SO>': '\x0e', '<FF>': '\x0c', '<LF>': '\x0a', '<CR>': '\x0d',
};

/** 现网 trace 的写法（`<FS>` 之类）→ 控制字符。 */
function decodeTokens(line) {
  return line.replace(/<(FS|GS|RS|US|ESC|SI|SO|FF|LF|CR)>/g, (t) => TOKENS[t]);
}

/** 读序列文件：一行一条报文，`#` 开头是注释。 */
function loadSequence(file) {
  return fs.readFileSync(file, 'utf8').split(/\r?\n/)
    .filter((l) => l.trim() !== '' && !l.startsWith('#'))
    .map(decodeTokens);
}

/** 上电 `12…1`、出主管 `12…300`。 */
function isDownloadTrigger(parsed) {
  return parsed.messageClass === '1' && parsed.subClass === '2' &&
    (parsed.fields[3] === '1' || parsed.fields[3] === '300');
}

const isSolicitedStatus = (parsed) => parsed.messageClass === '2' && parsed.subClass === '2';
const kindOf = (m) => m.split(FS)[3];
const command = (code) => ['10', '000', '000', code].join(FS);

/**
 * 一次下载。`messages` 是要发的报文（已解码）；`configId` 是上一次下发的配置 ID（这一次发它 + 1）；
 * `fitMessages` 给了就替换序列里的 FIT（`30…15`）。
 */
function createDownload({ messages, configId = 0, fitMessages } = {}) {
  let list = messages.slice();
  if (fitMessages) {
    const at = list.findIndex((m) => kindOf(m) === '15');
    list = list.filter((m) => kindOf(m) !== '15');
    if (at >= 0) list.splice(at, 0, ...fitMessages);
  }
  let index = 0;
  let id = configId;
  const self = {
    messages: list,
    done: false,
    get configId() { return id; },
    start() { return self.sendAt(); },
    sendAt() {
      let m = list[index++];
      if (kindOf(m) === '16') {
        id = id % 9999 + 1;
        m = m.split(FS).slice(0, 4).concat(String(id).padStart(4, '0')).join(FS);
      }
      return m;
    },
    /** 终端回了一条报文：是 `22…` 就发下一条（或最后的 10 1 / 10 2），否则不动。 */
    next(parsed) {
      if (self.done || !isSolicitedStatus(parsed)) return null;
      if (index < list.length) return self.sendAt();
      self.done = true;
      const counters = parsed.fields.slice(4).join(FS);
      const status = (counters.split('DI01' + RS)[1] || '').split(RS)[0];
      return command(status === '@@@@' ? '2' : '1');
    },
  };
  return self;
}

module.exports = { decodeTokens, loadSequence, isDownloadTrigger, createDownload };
