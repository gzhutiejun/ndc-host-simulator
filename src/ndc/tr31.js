const crypto = require('node:crypto');
const { HEX_32, kvv } = require('./eki');

/**
 * TR-31 / ANSI X9.143 key block 构造器（双倍长 TDES，版本 A / B / C），给 /api/push type=tr31 用。
 * 全部走 Node 原生 crypto 的 des-ede（2-key）；CMAC 自写。unwrapTr31 只给测试往返用。
 *   A / C：KBEK = KBPK ^ 0x45，KBMK = KBPK ^ 0x4D；CBC，IV = 头前 8 个 ASCII 字节；
 *          MAC = 对「头 ‖ 密文」的 TDES-CBC-MAC（零 IV）取前 4 字节。
 *   B    ：子密钥由 KBPK 经 CMAC 推导；MAC = CMAC(KBAK, 头 ‖ 明文)（8 字节），同时作 CBC 的 IV。
 * 明文 = 2 字节位长（大端）‖ 密钥 ‖ 填充。
 */

const VERSIONS = ['A', 'B', 'C'];

function ede(mode, key, data, iv) {
  const c = crypto.createCipheriv(`des-ede-${mode}`, key, iv || null);
  c.setAutoPadding(false);
  return Buffer.concat([c.update(data), c.final()]);
}
function unede(mode, key, data, iv) {
  const c = crypto.createDecipheriv(`des-ede-${mode}`, key, iv || null);
  c.setAutoPadding(false);
  return Buffer.concat([c.update(data), c.final()]);
}
const xorConst = (k, b) => Buffer.from(k.map((x) => x ^ b));

function cbcMac(key, data) {
  const ct = ede('cbc', key, data, Buffer.alloc(8));
  return ct.subarray(ct.length - 8);
}

function shiftLeft(b) {
  const o = Buffer.alloc(b.length);
  let carry = 0;
  for (let i = b.length - 1; i >= 0; i -= 1) {
    o[i] = ((b[i] << 1) & 0xff) | carry;
    carry = b[i] >> 7;
  }
  return o;
}

function cmac(key, msg) {
  const L = ede('ecb', key, Buffer.alloc(8));
  const k1 = shiftLeft(L);
  if (L[0] & 0x80) k1[7] ^= 0x1b;
  const k2 = shiftLeft(k1);
  if (k1[0] & 0x80) k2[7] ^= 0x1b;
  const n = Math.max(1, Math.ceil(msg.length / 8));
  const lastRaw = msg.subarray((n - 1) * 8);
  let last;
  if (msg.length > 0 && msg.length % 8 === 0) {
    last = Buffer.from(lastRaw.map((x, i) => x ^ k1[i]));
  } else {
    const p = Buffer.alloc(8);
    lastRaw.copy(p);
    p[lastRaw.length] = 0x80;
    last = Buffer.from(p.map((x, i) => x ^ k2[i]));
  }
  return cbcMac(key, Buffer.concat([msg.subarray(0, (n - 1) * 8), last]));
}

// B 版子密钥：KBEK / KBAK 各 2 块（16 字节），2-key TDEA、128 位。
function deriveB(kbpk) {
  const mk = (usage) => Buffer.concat([1, 2].map((i) => cmac(kbpk,
    Buffer.from([i, (usage >> 8) & 0xff, usage & 0xff, 0x00, 0x00, 0x00, 0x00, 0x80]))));
  return { kbek: mk(0x0000), kbak: mk(0x0001) };
}

function buildTr31({
  kbpk, key, usage = 'P0', algorithm = 'T', mode = 'E', version = 'B', keyVersion = '00', exportability = 'N', pad,
} = {}) {
  if (typeof kbpk !== 'string' || !HEX_32.test(kbpk)) throw new Error('tr31: kbpk must be 32 hex characters');
  if (typeof key !== 'string' || !HEX_32.test(key)) throw new Error('tr31: key must be 32 hex characters');
  if (!VERSIONS.includes(version)) throw new Error('tr31: version must be A, B or C');
  const kbpkBuf = Buffer.from(kbpk, 'hex');
  const keyBuf = Buffer.from(key, 'hex');
  const padLen = (8 - ((2 + keyBuf.length) % 8)) % 8;
  let padding;
  if (pad === undefined || pad === null || pad === '') padding = crypto.randomBytes(padLen);
  else {
    if (typeof pad !== 'string' || !/^([0-9A-Fa-f]{2})*$/.test(pad) || pad.length < padLen * 2) {
      throw new Error(`tr31: pad must be at least ${padLen} bytes of hex`);
    }
    padding = Buffer.from(pad, 'hex').subarray(0, padLen);
  }
  const clear = Buffer.concat([Buffer.from([(keyBuf.length * 8) >> 8, (keyBuf.length * 8) & 0xff]), keyBuf, padding]);
  const macHexLen = version === 'B' ? 16 : 8;
  const total = 16 + clear.length * 2 + macHexLen;
  const header = `${version}${String(total).padStart(4, '0')}${usage}${algorithm}${mode}${keyVersion}${exportability}0000`;
  if (header.length !== 16) throw new Error('tr31: header fields have wrong length');
  const headerBuf = Buffer.from(header, 'ascii');
  let ct;
  let mac;
  if (version === 'B') {
    const { kbek, kbak } = deriveB(kbpkBuf);
    mac = cmac(kbak, Buffer.concat([headerBuf, clear]));
    ct = ede('cbc', kbek, clear, mac);
  } else {
    ct = ede('cbc', xorConst(kbpkBuf, 0x45), clear, headerBuf.subarray(0, 8));
    mac = cbcMac(xorConst(kbpkBuf, 0x4d), Buffer.concat([headerBuf, ct])).subarray(0, 4);
  }
  return {
    block: header + ct.toString('hex').toUpperCase() + mac.toString('hex').toUpperCase(),
    kcv: kvv(key),
  };
}

// 测试用：验 MAC 并取回密钥（大写 hex）。只处理无可选块的块。
function unwrapTr31(kbpk, block) {
  const kbpkBuf = Buffer.from(kbpk, 'hex');
  const version = block[0];
  if (parseInt(block.slice(1, 5), 10) !== block.length) throw new Error('tr31: length mismatch');
  if (parseInt(block.slice(12, 14), 10) !== 0) throw new Error('tr31: optional blocks not supported');
  const headerBuf = Buffer.from(block.slice(0, 16), 'ascii');
  const macHexLen = version === 'B' ? 16 : 8;
  const ct = Buffer.from(block.slice(16, block.length - macHexLen), 'hex');
  const macHex = block.slice(block.length - macHexLen);
  let clear;
  let expect;
  if (version === 'B') {
    const { kbek, kbak } = deriveB(kbpkBuf);
    clear = unede('cbc', kbek, ct, Buffer.from(macHex, 'hex'));
    expect = cmac(kbak, Buffer.concat([headerBuf, clear])).toString('hex');
  } else if (version === 'A' || version === 'C') {
    expect = cbcMac(xorConst(kbpkBuf, 0x4d), Buffer.concat([headerBuf, ct])).subarray(0, 4).toString('hex');
    clear = unede('cbc', xorConst(kbpkBuf, 0x45), ct, headerBuf.subarray(0, 8));
  } else throw new Error('tr31: unsupported version');
  if (expect.toUpperCase() !== macHex.toUpperCase()) throw new Error('tr31: MAC mismatch');
  return clear.subarray(2, 2 + clear.readUInt16BE(0) / 8).toString('hex').toUpperCase();
}

// push 缺省用途 / 模式：e -> P0/E，f -> M3/G，l -> M3/C
const DEFAULTS = { e: { usage: 'P0', mode: 'E' }, f: { usage: 'M3', mode: 'G' }, l: { usage: 'M3', mode: 'C' } };

module.exports = { buildTr31, unwrapTr31, cmac, DEFAULTS, VERSIONS };
