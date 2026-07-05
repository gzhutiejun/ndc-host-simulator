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
