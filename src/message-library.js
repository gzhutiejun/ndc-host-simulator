// 报文库加载器：读 NCR AP00_NDCHost 自带的 StandardInterface_*.doc（扩展名骗人，内容其实是
// 含控制字符的定长文本）。格式已经用真实文件核实过（见 docs/plans 里的记录）：
//
//   偏移 0     : "M1187RESV\r\n"  —— 11 字节文件头
//   偏移 11 起 : 定长 614 字节的记录，一条接一条，没有分隔符
//
// 每条记录：
//   [0-3]   4 字节，十进制、前导零 —— 载荷长度
//   [4-11]  8 字节 —— 键（NCR 自己的场景名，比如 "GIS     "、"A A  A A"；不是操作码，
//           不要拿它去跟 ATM 发来的报文配对，实测对不上）
//   [12..]  上面那个长度 —— 载荷，完整的 NDC 报文，含真实控制字符 FS/SO/SI
//   [之后]  补齐到 614 —— 空格（文件里偶尔混着 CRLF），丢弃
//
// 健壮性是这个模块的第一优先级：库文件是 NCR 给的第三方文件，坏一行不该让模拟器起不来。
// 三类坏记录——长度字段不是数字、声明长度超出记录容量、文件尾部凑不齐一条整记录——一律跳过
// 并计数，绝不抛错。

const { FS, C2T_CLASS } = require('./constants');
const { decodeText } = require('./framing');

const HEADER_SIZE = 11;
const RECORD_SIZE = 614;
const LENGTH_FIELD_SIZE = 4;
const KEY_FIELD_SIZE = 8;
const PAYLOAD_CAPACITY = RECORD_SIZE - LENGTH_FIELD_SIZE - KEY_FIELD_SIZE; // 602

const LENGTH_FIELD_RE = /^[0-9]{4}$/;

/**
 * 解析报文库文件。
 *
 * @param {Buffer|string} input 文件内容；字符串按 latin1 处理（跟仓库里其它地方一致，
 *   保证 0x00-0xFF 每个字节原样往返，不会被当成 UTF-8 弄坏控制字符）。
 * @returns {Array<{key: string, payload: string}>} 数组本身就是 `[{key, payload}]`，可以直接
 *   当列表用（`JSON.stringify` 序列化时也只会带上这些元素，额外挂的 `skipped`/`skippedDetails`
 *   不是数字下标，不会混进去）；同时数组上挂了两个属性，供调用方记日志：
 *     - `skipped`：跳过的坏记录条数
 *     - `skippedDetails`：`{ index, reason }[]`，index 是记录序号（0 起），reason 是人话原因
 */
function parseLibrary(input) {
  const buf = Buffer.isBuffer(input) ? input : Buffer.from(input, 'latin1');
  const records = [];
  records.skipped = 0;
  records.skippedDetails = [];

  const skip = (index, reason) => {
    records.skipped += 1;
    records.skippedDetails.push({ index, reason });
  };

  if (buf.length < HEADER_SIZE) {
    // 连文件头都不够长：当成空库，不抛错。
    if (buf.length > 0) skip(0, `文件只有 ${buf.length} 字节，不够 ${HEADER_SIZE} 字节的文件头`);
    return records;
  }

  const body = buf.subarray(HEADER_SIZE);
  const count = Math.floor(body.length / RECORD_SIZE);
  const trailingBytes = body.length - count * RECORD_SIZE;
  if (trailingBytes > 0) {
    skip(count, `文件尾部剩 ${trailingBytes} 字节，凑不齐一条整记录（${RECORD_SIZE} 字节），已丢弃`);
  }

  for (let i = 0; i < count; i += 1) {
    const rec = body.subarray(i * RECORD_SIZE, (i + 1) * RECORD_SIZE);
    const lengthText = rec.subarray(0, LENGTH_FIELD_SIZE).toString('latin1');
    if (!LENGTH_FIELD_RE.test(lengthText)) {
      skip(i, `长度字段不是 4 位十进制数字："${lengthText}"`);
      continue;
    }
    const len = parseInt(lengthText, 10);
    if (len > PAYLOAD_CAPACITY) {
      skip(i, `声明长度 ${len} 超出记录容量 ${PAYLOAD_CAPACITY}`);
      continue;
    }
    // 键是定长 8 字节字段，尾部空格是补位，trim 掉；键内部的空格（比如 "A A  A A"）
    // 是场景名本身的一部分，原样保留——测试里两种键都覆盖到了。
    const key = rec
      .subarray(LENGTH_FIELD_SIZE, LENGTH_FIELD_SIZE + KEY_FIELD_SIZE)
      .toString('latin1')
      .replace(/\s+$/, '');
    const payloadStart = LENGTH_FIELD_SIZE + KEY_FIELD_SIZE;
    const payload = decodeText(rec.subarray(payloadStart, payloadStart + len));
    records.push({ key, payload });
  }

  return records;
}

// 类 1（终端命令）里，命令码到人话名字的映射。只收录在真实报文库样本里实测验证过、
// 且 plan 明确点名的两个——手册 Table 10-1 里其它命令码没有样本可核对，宁可缺，不编。
const TERMINAL_COMMAND_LABELS = {
  1: 'Go In Service',
  2: 'Go Out Of Service',
};

// 类 3（数据命令）里，只有 COMMSKEY 样例（子码 32）在 plan 里被明确点名是"密钥变更"。
// 其余子码（比如 21100111，样本里出现在 OAR* 一类屏幕文案更新报文里）含义不确定，不编。
const DATA_COMMAND_LABELS = {
  32: '密钥变更',
};

// 控制字符渲染成可见符号，只用在拼 label 的时候（不改 fields/payload 本身），
// 避免出钞字段里混进 GS 之类的分隔符时 label 变成一堆看不见的字节。
const VISIBLE_SYMBOLS = {
  '\x1c': '|', // FS
  '\x1d': '~', // GS
  '\x1e': '^', // RS
  '\x0e': '<', // SO
  '\x0f': '>', // SI
};
function toVisible(str) {
  return String(str).replace(/[\x1c\x1d\x1e\x0e\x0f]/g, (ch) => VISIBLE_SYMBOLS[ch]);
}

/**
 * 从载荷推出人类可读的标签。键（NCR 场景名，比如 "A A  A A"）本身不是人话，页面上要能
 * 挑，就得从载荷内容反推出"这是什么"。拿不准的字段一律说明白拿不准，不猜。
 *
 * @param {Buffer|string} payload
 * @returns {{messageClass: string, subClass: string|null, label: string, fields: string[]}}
 */
function describe(payload) {
  const text = typeof payload === 'string' ? payload : decodeText(payload);
  if (!text) {
    return { messageClass: '', subClass: null, label: '空报文', fields: [] };
  }

  const fields = text.split(FS);
  const messageClass = text.charAt(0);

  if (messageClass === '1') {
    const code = fields.length > 3 ? fields[3] : undefined;
    const known = code !== undefined ? TERMINAL_COMMAND_LABELS[code] : undefined;
    let label;
    if (known) label = `终端命令 · ${known}`;
    else if (code !== undefined) label = `终端命令 · 命令码 ${toVisible(code)}（未知）`;
    else label = '终端命令（无法识别命令码）';
    return { messageClass, subClass: code !== undefined ? code : null, label, fields };
  }

  if (messageClass === '3') {
    const code = fields.length > 3 ? fields[3] : undefined;
    const known = code !== undefined ? DATA_COMMAND_LABELS[code] : undefined;
    let label;
    if (known) label = known;
    else if (code !== undefined) label = `数据命令 · 子码 ${toVisible(code)}`;
    else label = '数据命令（无法识别子码）';
    return { messageClass, subClass: code !== undefined ? code : null, label, fields };
  }

  if (messageClass === '4') {
    const nextState = fields.length > 3 ? fields[3] : undefined;
    if (nextState === undefined) {
      return { messageClass, subClass: null, label: '交易应答（无法识别下一状态）', fields };
    }
    const dispense = fields.length > 4 ? fields[4] : '';
    let label = `交易应答 · 下一状态 ${toVisible(nextState)}`;
    if (dispense) label += ` · 出钞 ${toVisible(dispense)}`;
    return { messageClass, subClass: nextState, label, fields };
  }

  // 未识别的报文类：仓库自己的 C2T_CLASS 常量里如果有登记名字（比如类 8 EMVConfig），
  // 用上；没有就老实说"类 N 报文"，不编具体含义。
  const knownClassName = C2T_CLASS[messageClass];
  const label = knownClassName ? `${knownClassName} 报文` : `类 ${messageClass} 报文`;
  return { messageClass, subClass: null, label, fields };
}

module.exports = { parseLibrary, describe };
