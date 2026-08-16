const { encodeChar, decodeByte } = require('./ebcdic');

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

/**
 * 纯 latin1，**对传输码免疫**。
 *
 * 这一对是"字节 ↔ 字符串"的原始转换，`message-library.js` 用它读磁盘上的 NCR 报文库。
 * 那是文件编码，不是线缆编码 —— 跟着传输码换的话，配成 EBCDIC 时整个报文库会被读成
 * 乱码。要换码的是 encodeWire/decodeWire，不是这一对。
 */
function encodeText(str) {
  return Buffer.from(str, 'latin1');
}

function decodeText(buf) {
  return buf.toString('latin1');
}

/**
 * socket 边界上的编解码：按当前传输码换码（见 src/ebcdic.js）。
 *
 * 出站（server.js 写 socket 之前）和入站（parser.js 解析之前）都只经过这一对，所以
 * 引擎、规则匹配、报文库、handler 全都照旧在 ASCII 串上工作。
 *
 * 长度前缀由 encodeLength 单独加，不经过这里 —— 它是二进制长度而不是字符，换码会把
 * 0x04 这样的长度改成 0x37。
 */
function encodeWire(str) {
  const out = Buffer.allocUnsafe(str.length);
  for (let i = 0; i < str.length; i += 1) out[i] = encodeChar(str.charCodeAt(i));
  return out;
}

function decodeWire(buf) {
  let s = '';
  for (let i = 0; i < buf.length; i += 1) s += String.fromCharCode(decodeByte(buf[i]));
  return s;
}

module.exports = {
  encodeLength, createDecoder, MAX_FRAME, encodeText, decodeText, encodeWire, decodeWire,
};
