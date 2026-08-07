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

module.exports = { buildTerminalCommand };
