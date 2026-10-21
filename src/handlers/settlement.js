const { FS } = require('../constants');
const { buildTransactionReply } = require('../ndc/transactionReply');
const { extractRequest } = require('../ndc/transactionRequest');
const goInService = require('./goInService');

// 主管结算（Host Settlement）J 族 / C A 应答。ATM 按 MCN 严格配对应答：凭条字段第一个字符
// 必须等于请求 MCN；成功 = 功能标识 4（带 next state）或 5。
//   settlement    —— 回交易应答：屏幕 "2235"+功能标识+"000"（JA/JB 再带 CC=7×5 位钞箱计数）、
//                    凭条 MCN+"0"+"3"+正文。正文取报文库里该操作码（精确键或去尾空格键）的
//                    凭条段（FS 切开的下标 6）去掉前 3 个字符，库里没有就写 "SETTLEMENT <操作码>"。
//   settlementGis —— P20（退出主管）之后主机自动发 Go In Service；autoGisOnP20:false 时不应答。
module.exports = function makeSettlement(cfg = {}, { library = [] } = {}) {
  const nextState = cfg.nextState != null ? cfg.nextState : '001';
  const functionId = cfg.functionId != null ? cfg.functionId : '5';
  const cassetteCounts = Array.isArray(cfg.cassetteCounts) ? cfg.cassetteCounts : [2000, 2000, 2000, 2000, 0, 0, 0];
  const autoGisOnP20 = cfg.autoGisOnP20 !== false;

  const index = new Map();
  for (const entry of library) {
    if (entry && typeof entry.key === 'string') index.set(entry.key, entry.payload);
  }

  function libraryBody(opcode) {
    const payload = index.get(opcode) !== undefined ? index.get(opcode) : index.get(opcode.trimEnd());
    if (payload === undefined) return null;
    const segment = payload.split(FS)[6];
    return segment === undefined ? null : segment.slice(3);
  }

  function settlement(parsed) {
    const req = extractRequest(parsed);
    const opcode = (parsed.fields || [])[7] || '';
    const withCounts = opcode.startsWith('JA') || opcode.startsWith('JB');
    const counts = withCounts
      ? 'CC=' + cassetteCounts.map((n) => String(n).padStart(5, '0')).join('')
      : '';
    const body = libraryBody(opcode);
    return buildTransactionReply({
      luno: req.luno,
      nextState,
      fieldG: '',
      screen: '2235' + functionId + '000' + counts,
      printer: req.mcn + '0' + '3' + (body != null ? body : 'SETTLEMENT ' + opcode.trimEnd()),
    });
  }

  function settlementGis(parsed, session, helpers) {
    return autoGisOnP20 ? goInService(parsed, session, helpers) : null;
  }

  return { settlement, settlementGis };
};
