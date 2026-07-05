const C = require('../constants');

function fmtAmount(n) {
  return n.toFixed(2);
}
function pad2(n) {
  return String(n).padStart(2, '0');
}
function fmtDate(d) {
  return `${pad2(d.getUTCDate())}/${pad2(d.getUTCMonth() + 1)}/${String(d.getUTCFullYear()).slice(-2)}`;
}
function fmtTime(d) {
  return `${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())}`;
}

function applyReceipt(tpl, values = {}) {
  const v = (x) => (x != null ? x : '');
  return String(tpl)
    .replace(/<LF>/g, '\x0a')
    .replace(/<FF>/g, '\x0c')
    .replace(/<ESC>/g, '\x1b')
    .replace(/<SO>/g, C.SO)
    .replace(/<SI>/g, C.SI)
    .replace(/<GS>/g, C.GS)
    .replace(/<AMOUNT>/g, v(values.amount))
    .replace(/<BALANCE>/g, v(values.balance))
    .replace(/<PAN>/g, v(values.pan))
    .replace(/<DATE>/g, v(values.date))
    .replace(/<TIME>/g, v(values.time))
    .replace(/<RECNO>/g, v(values.recno))
    .replace(/<LUNO>/g, v(values.luno));
}

function arcToHex(arc) {
  return [...String(arc)].map((ch) => ch.charCodeAt(0).toString(16).padStart(2, '0')).join('');
}

function buildCam(arc, include) {
  return include ? '5CAM8A02' + arcToHex(arc) : null;
}

module.exports = { applyReceipt, fmtAmount, fmtDate, fmtTime, arcToHex, buildCam };
