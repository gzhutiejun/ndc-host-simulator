function breakdown(amount, cassettes = [50, 100, 500, 1000]) {
  const counts = new Array(cassettes.length).fill(0);
  // 贪心：按面额从大到小分配
  const order = cassettes
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
  const fieldG = counts.map((c) => String(c).padStart(2, '0')).join('');
  return { fieldG, ok, counts };
}

module.exports = { breakdown };
