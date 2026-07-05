function extractWithdrawal(parsed, config = {}) {
  const amountFieldIndex = config.amountFieldIndex != null ? config.amountFieldIndex : 8;
  const fields = parsed.fields || [];
  const amountRaw = fields[amountFieldIndex];
  const amount = amountRaw && /^\d+$/.test(amountRaw) ? parseInt(amountRaw, 10) : null;
  const field4 = fields[4] || '';
  const mcn = field4.length > 1 ? field4[1] : '';
  return {
    amount,
    luno: parsed.luno,
    stn: fields[2] || '',
    mcn,
    panMasked: fields[5] || '',
  };
}

module.exports = { extractWithdrawal };
