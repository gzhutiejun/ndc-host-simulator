const crypto = require('node:crypto');

/**
 * 主机密钥命令助手（报文类 3 子类 3 / 4，EKI）。只给模拟器发 EKI 用，不做 MAC 计算 / 校验。
 * 报文标识 = 子类 + 修饰符；数据 = 用主密钥（2-key 3DES）加密的新键，每字节 3 位十进制；
 * 子类 4 在数据前加前缀（双倍长 030、单倍长 018）。
 */

const HEX_32 = /^[0-9A-Fa-f]{32}$/;
const HEX_16_OR_32 = /^([0-9A-Fa-f]{16}|[0-9A-Fa-f]{32})$/;

// 2-key 3DES（des-ede-ecb）；单倍长按 K||K 算，不依赖 OpenSSL 3 的 legacy des-ecb。
function tdesEcb(keyBuf, input) {
  const k = keyBuf.length === 8 ? Buffer.concat([keyBuf, keyBuf]) : keyBuf;
  const cipher = crypto.createCipheriv('des-ede-ecb', k, null);
  cipher.setAutoPadding(false);
  return Buffer.concat([cipher.update(input), cipher.final()]);
}

// KVV：用该键加密 8 个零字节，取前 3 字节，大写 hex。
function kvv(keyHex) {
  return tdesEcb(Buffer.from(keyHex, 'hex'), Buffer.alloc(8)).subarray(0, 3).toString('hex').toUpperCase();
}

function buildEki({ subclass, modifier, masterKey, newKey } = {}) {
  if (subclass !== '3' && subclass !== '4') throw new Error('eki: subclass must be "3" or "4"');
  if (typeof modifier !== 'string' || modifier === '') throw new Error('eki: modifier is required');
  if (typeof masterKey !== 'string' || !HEX_32.test(masterKey)) {
    throw new Error('eki: masterKey must be 32 hex characters');
  }
  if (typeof newKey !== 'string' || !HEX_16_OR_32.test(newKey)) {
    throw new Error('eki: newKey must be 16 or 32 hex characters');
  }
  const cipher = tdesEcb(Buffer.from(masterKey, 'hex'), Buffer.from(newKey, 'hex'));
  let data = Array.from(cipher, (b) => String(b).padStart(3, '0')).join('');
  if (subclass === '4') data = (newKey.length === 32 ? '030' : '018') + data;
  return { identifier: subclass + modifier, data, expectedKvv: kvv(newKey) };
}

module.exports = { buildEki, kvv, HEX_32, HEX_16_OR_32 };
