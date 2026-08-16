const { FS } = require('./constants');

/**
 * 组装一条主机→ATM 的终端命令。
 * 手册 APTRA Advance NDC Reference Manual (B006-6180) Table 10-1：
 *
 *   "1"[响应标志] FS [LUNO] FS [消息序号] FS <命令码><命令修饰符?>
 *
 * 命令码与修饰符是同一个字段里连写的两个字符，不是两个字段。
 */
function buildTerminalCommand({ code, modifier = '', luno = '', msn = '', responseFlag = '' } = {}) {
  if (!code) throw new Error('buildTerminalCommand: code is required');
  return ['1' + responseFlag, luno, msn, code + modifier].join(FS);
}

/**
 * 组装一条主机→ATM 的数据命令（报文类 3）。
 *
 *   "3"[响应标志] FS [LUNO] FS [消息序号] FS <报文标识> FS <数据>
 *
 * 报文标识取值参照随仓库分发的报文库样本（messages/StandardInterface_0300_*.doc）：
 * 11=DD 配置装载、15=FIT 装载、16=Configuration ID、32/42=密钥变更。手册里其它取值
 * 没有样本可核对，这里不做枚举校验，调用方给什么就发什么。
 */
function buildDataCommand({ identifier, data = '', luno = '', msn = '', responseFlag = '' } = {}) {
  if (!identifier) throw new Error('buildDataCommand: identifier is required');
  return ['3' + responseFlag, luno, msn, identifier, data].join(FS);
}

// FIT 装载的报文标识。依据是报文库里 key 就叫 "FIT" 的那条真实样本（报文标识字段为 "15"）。
const FIT_IDENTIFIER = '15';

// FIT 条目里每个字节写成 3 位十进制（000-255），所以整条只能是数字、长度必是 3 的倍数。
// 这两条是从样本上能直接读出来的；至于 35 个字节各自是什么字段（INDX/PAN 偏移/PIN 长度……），
// 手头没有权威依据，这里一概不校验、不解释——发什么由调用方的配置说了算。
const DIGITS_ONLY = /^[0-9]+$/;

/**
 * 组装一条 FIT 下发命令。
 *
 * 数据段是若干条 FIT 条目，每条后面跟一个 FS——样本里单条 FIT 的末尾就带着这个 FS，
 * 照抄。
 *
 * @param {object} opts
 * @param {string[]} opts.entries 每条是一串 3 位十进制的字节值
 */
function buildFitDownload({ entries, luno = '', msn = '', responseFlag = '' } = {}) {
  if (!Array.isArray(entries) || entries.length === 0) {
    throw new Error('buildFitDownload: entries must be a non-empty array of FIT entry strings');
  }
  for (const entry of entries) {
    if (typeof entry !== 'string' || !DIGITS_ONLY.test(entry)) {
      throw new Error(`buildFitDownload: FIT entry must be digits only, got "${entry}"`);
    }
    if (entry.length % 3 !== 0) {
      throw new Error(
        `buildFitDownload: FIT entry length must be a multiple of 3 (3 digits per byte), got ${entry.length}`,
      );
    }
  }
  const data = entries.map((entry) => entry + FS).join('');
  return buildDataCommand({ identifier: FIT_IDENTIFIER, data, luno, msn, responseFlag });
}

module.exports = { buildTerminalCommand, buildDataCommand, buildFitDownload };
