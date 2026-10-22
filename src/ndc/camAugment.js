const { FS } = require('../constants');
const { extractRequest } = require('./transactionRequest');
const { buildCam } = require('./receipt');

/** class 4 应答的固定字段数：4 / luno / stn / NS / G / 屏幕 / 打印；第 7 个下标起是附加段。 */
const FIXED_FIELDS = 7;

/**
 * 8b：给交易应答补 CAM 段（`cfg` = config.cam）。只在 enabled、请求带 `5CAM` 段、
 * 载荷是 class 4 且还没有 `5` 段、且没配 `omit` 时才动，其余原样返回。
 * `badIad` 把 IAD 首字节改成 FF（外部认证 6A82，只置 TVR，交易不因此失败）。
 */
function augmentCam(parsed, result, cfg) {
  if (!cfg || cfg.enabled !== true || cfg.omit === true) return result;
  const payload = result && result.payload;
  if (typeof payload !== 'string' || payload[0] !== '4' || payload[1] !== FS) return result;
  if (!extractRequest(parsed).cam) return result;
  const fields = payload.split(FS);
  if (fields.slice(FIXED_FIELDS).some((f) => f.startsWith('5'))) return result;
  while (fields.length < FIXED_FIELDS) fields.push('');
  const iad = cfg.iad != null ? cfg.iad : '11223344556677883030';
  const cam = buildCam({
    arc: cfg.arc,
    iad: cfg.badIad === true ? 'FF' + iad.slice(2) : iad,
    scripts: cfg.scripts,
  });
  return { ...result, payload: fields.join(FS) + FS + cam };
}

module.exports = { augmentCam };
