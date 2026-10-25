const crypto = require('node:crypto');
const { FS } = require('../constants');

/**
 * TR-34 远程装键（报文类 3 子类 4 修饰符 N g h i k L M O Q X Y Z a b c）的下发构造与应答解码。
 * 只给 /api/push type=tr34 用：证书 / token 是固定的、结构合法的 DER 样本（30 82 hi lo + 内容），
 * 不是真证书，ATM 侧只校验外层结构。base94 与 app 的 tr34-data.ts 同一算法（同一份向量互验）。
 */

// 每 4 字节（不足补 0）-> 5 个字符：v = b0 + b1*256 + b2*256^2 + b3*256^3，依次 chr(v % 94 + 32)。
function base94Encode(buf) {
  const src = Buffer.from(buf);
  let out = '';
  for (let i = 0; i < src.length; i += 4) {
    let v = 0;
    for (let j = 3; j >= 0; j -= 1) v = v * 256 + (src[i + j] || 0);
    for (let k = 0; k < 5; k += 1) {
      out += String.fromCharCode((v % 94) + 32);
      v = Math.floor(v / 94);
    }
  }
  return out;
}

// 每 5 字符 -> 4 字节；长度不是 5 的倍数或字符越界 -> undefined。
function base94Decode(s) {
  if (typeof s !== 'string' || s.length % 5 !== 0) return undefined;
  const out = Buffer.alloc((s.length / 5) * 4);
  for (let i = 0; i < s.length; i += 5) {
    let v = 0;
    for (let j = 4; j >= 0; j -= 1) {
      const c = s.charCodeAt(i + j) - 32;
      if (c < 0 || c > 93) return undefined;
      v = v * 94 + c;
    }
    for (let k = 0; k < 4; k += 1) {
      out[(i / 5) * 4 + k] = v % 256;
      v = Math.floor(v / 256);
    }
  }
  return out;
}

// 确定性填充内容：sha256(label || 计数) 链，保证四份互不相同、每次启动一致。
function fakeDer(label, contentLen) {
  const parts = [];
  let n = 0;
  let have = 0;
  while (have < contentLen) {
    const h = crypto.createHash('sha256').update(`${label}:${n}`).digest();
    parts.push(h);
    have += h.length;
    n += 1;
  }
  const content = Buffer.concat(parts).subarray(0, contentLen);
  return Buffer.concat([Buffer.from([0x30, 0x82, (contentLen >> 8) & 0xff, contentLen & 0xff]), content]);
}

const SAMPLES = {
  hostCert: fakeDer('tr34-host-cert', 300),
  tr34Token: fakeDer('tr34-token', 260),
  unbindSigned: fakeDer('tr34-unbind-signed', 140),
  rsaCert: fakeDer('tr34-rsa-cert', 280),
};

const SAMPLE_BY_MODIFIER = {
  L: 'rsaCert', X: 'hostCert', Z: 'hostCert', a: 'hostCert', Y: 'tr34Token', O: 'tr34Token', b: 'unbindSigned', c: 'unbindSigned',
};
const NO_PAYLOAD = new Set(['N', 'g', 'h', 'i', 'Q']);
const MODIFIERS = new Set([...NO_PAYLOAD, 'k', 'M', ...Object.keys(SAMPLE_BY_MODIFIER)]);

function lenPrefixed(body) {
  return body.length.toString(16).toUpperCase().padStart(3, '0') + body;
}

function buildTr34Command({ modifier, data, luno = '000' } = {}) {
  if (!MODIFIERS.has(modifier)) throw new Error(`tr34: unknown modifier "${modifier}"`);
  const head = ['3', luno, '', `4${modifier}`];
  if (NO_PAYLOAD.has(modifier)) return head.join(FS);
  if (modifier === 'k') return [...head, `001${data != null ? data : 'b'}`].join(FS);
  if (modifier === 'M') return [...head, `001${data != null ? data : '0'}`].join(FS);
  const body = data != null ? data : base94Encode(SAMPLES[SAMPLE_BY_MODIFIER[modifier]]);
  return [...head, lenPrefixed(body)].join(FS);
}

const REPLY_NAMES = {
  3: '新键 KVV', 5: '装键确认', 7: 'RSA KVV', 8: 'SST 证书', 9: 'SST 随机数',
  B: 'B 类', H: '主机证书', I: 'EPP 解绑确认', J: 'J 类', K: 'K 类', L: '解绑待签数据',
};

/**
 * ATM 对 TR-34 命令的应答：23 FS luno FS FS <id> [FS data]。证书 / token 一律只给长度与 sha256 前 8 位。
 * id 3 同时是普通密钥命令的新键 KVV（6 位 hex），所以 3 只在数据超过 6 字符时才当 TR-34 数据。
 */
function extractTr34Reply(fields) {
  const head = fields[0] || '';
  if (head !== '23') return undefined;
  const id = fields[3];
  if (!Object.prototype.hasOwnProperty.call(REPLY_NAMES, id)) return undefined;
  const data = fields[4] || '';
  if (id === '3' && data.length <= 6) return undefined;
  const out = { id, name: REPLY_NAMES[id], len: data.length };
  if (data) out.sha8 = crypto.createHash('sha256').update(data, 'latin1').digest('hex').slice(0, 8);
  out.text = `TR34 ${out.name} len=${out.len}${out.sha8 ? ` sha256=${out.sha8}` : ''}`;
  return out;
}

module.exports = {
  base94Encode, base94Decode, SAMPLES, buildTr34Command, extractTr34Reply, MODIFIERS,
};
