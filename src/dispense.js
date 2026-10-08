/**
 * 把金额贪心地分到各钞箱。
 *
 * @param cassettes 每箱的面额：数字，或 `{ value, currency }`。带币种的箱只在请求币种相同时
 *   参与分配（CUBC 一台机器同时装 USD 与 KHR：A=USD 50、B=USD 10、C=KHR 50000、D=USD 100）。
 * @param opts.currency 请求币种；不给时所有箱都参与（与改动前一致）。
 * @param opts.slots 出钞字段补到几组两位数；DDC 现网是 8 组（`0104000100000000`）。不给时按钞箱数。
 */
function breakdown(amount, cassettes = [50, 100, 500, 1000], opts = {}) {
  const denoms = cassettes.map((c) => {
    if (typeof c === 'number') return c;
    if (opts.currency && c.currency && c.currency !== opts.currency) return 0;
    return c.value;
  });
  const counts = new Array(denoms.length).fill(0);
  // 贪心：按面额从大到小分配
  const order = denoms
    .map((denom, idx) => ({ denom, idx }))
    .sort((a, b) => b.denom - a.denom);
  let remaining = amount;
  for (const { denom, idx } of order) {
    if (denom <= 0) continue;
    const n = Math.floor(remaining / denom);
    counts[idx] = n;
    remaining -= n * denom;
  }
  const ok = remaining === 0 && amount > 0;
  const slots = Math.max(opts.slots || 0, counts.length);
  const padded = [...counts, ...new Array(slots - counts.length).fill(0)];
  const fieldG = padded.map((c) => String(c).padStart(2, '0')).join('');
  return { fieldG, ok, counts };
}

module.exports = { breakdown };
