const { FS } = require('../constants');

function buildTransactionReply({
  luno,
  stn = '',
  nextState,
  fieldG,
  screen = '',
  printer = '',
  cam = null,
} = {}) {
  const fields = ['4', luno, stn, nextState, fieldG, screen, printer];
  if (cam != null) fields.push(cam);
  return fields.join(FS);
}

module.exports = { buildTransactionReply };
