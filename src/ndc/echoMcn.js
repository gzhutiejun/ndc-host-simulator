const { FS } = require('../constants');

/**
 * 交易应答回显请求的 MCN（报文协调号）：打印字段（第 6 段）第 1 个字符 = 请求第 4 段第 2 个字符。
 * CUBC 现网主机每条应答都回显（acc-cubc 2024 trace 647/647；ITR 回送之后回显回送用的那个，2026 现网），
 * ATM（acc-cubc 2026-10-30 起，同旧终端 AE）拿它判断应答是不是回给最近那条请求的。
 *
 * 打印字段以通配 '0' 开头的（处理器 / 模板写死的 `0…`）换成请求的 MCN；打印字段为空或缺的补成
 * `<MCN>00`（退卡、不打印）：o / p / q 三个字符必填（手册 Table 10-15），现网每条应答都带（第 1 段是
 * `<MCN>01<FF>`），ATM 照 AE 对缺的按格式错拒（A01）。已经带了具体 MCN 的、不是交易应答的不碰。控制台 / `/api/next` 的覆盖不经过这里（调用方跳过），
 * 好让测试故意发一条 MCN 不对的应答。
 */
function echoMcn(parsed, payload) {
  if (typeof payload !== 'string' || !parsed || !Array.isArray(parsed.fields)) return payload;
  if (parsed.fields[0] !== '11') return payload;
  const mcn = (parsed.fields[4] || '').charAt(1);
  if (!mcn) return payload;
  const f = payload.split(FS);
  if (f[0] !== '4') return payload;
  if (!f[6]) {
    while (f.length < 7) f.push('');
    f[6] = `${mcn}00`;
  } else if (f[6].charAt(0) === '0') {
    f[6] = mcn + f[6].slice(1);
  } else {
    return payload;
  }
  return f.join(FS);
}

module.exports = { echoMcn };
