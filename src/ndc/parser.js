const { FS, ETX, T2C_CLASS } = require('../constants');
// decodeWire 而不是 decodeText：这里拿到的是 socket 上来的字节，要按传输码换码。
// （decodeText 是纯 latin1，留给 message-library 读磁盘上的报文库用。）
const { decodeWire } = require('../framing');

function classify(messageClass, subClass) {
  if (messageClass === '1' && subClass === '1') return 'TransactionRequest';
  if (messageClass === '1' && subClass === '2') return 'UnsolicitedStatus';
  if (messageClass === '2') return 'SolicitedStatus';
  return T2C_CLASS[messageClass] || 'Unknown';
}

function parse(payload) {
  const text = decodeWire(payload);
  const hasETX = text.length > 0 && text.charCodeAt(text.length - 1) === ETX.charCodeAt(0);
  const body = hasETX ? text.slice(0, -1) : text;

  const fields = body.split(FS); // 保留空字段
  const messageClass = body.charAt(0) || '';
  const subClass = body.charAt(1) || '';
  const luno = fields.length > 1 ? fields[1] : '';

  return {
    messageClass,
    subClass,
    luno,
    fields,
    hasETX,
    mac: null,
    type: classify(messageClass, subClass),
    raw: payload,
  };
}

module.exports = { parse, classify };
