const { FS } = require('../constants');

/**
 * 交易应答回显请求的 MCN（报文协调号）：打印字段（第 6 段）第 1 个字符 = 请求第 4 段第 2 个字符。
 * CUBC 现网主机每条应答都回显（acc-cubc 2024 trace 647/647；ITR 回送之后回显回送用的那个，2026 现网），
 * ATM（acc-cubc 2026-10-30 起，同旧终端 AE）拿它判断应答是不是回给最近那条请求的。
 *
 * 只改打印字段以通配 '0' 开头的交易应答（处理器 / 模板写死的 `0…`），别的原样返回：打印字段为空的、
 * 已经带了具体 MCN 的、不是交易应答的都不碰。控制台 / `/api/next` 的覆盖不经过这里（调用方跳过），
 * 好让测试故意发一条 MCN 不对的应答。
 */
function echoMcn(parsed, payload) {
  if (typeof payload !== 'string' || !parsed || !Array.isArray(parsed.fields)) return payload;
  if (parsed.fields[0] !== '11') return payload;
  const mcn = (parsed.fields[4] || '').charAt(1);
  if (!mcn) return payload;
  const f = payload.split(FS);
  if (f[0] !== '4' || !f[6] || f[6].charAt(0) !== '0') return payload;
  f[6] = mcn + f[6].slice(1);
  return f.join(FS);
}

module.exports = { echoMcn };
