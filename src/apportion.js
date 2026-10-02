// Stable apportionment of an integer total across items, proportional to
// item amount. Remainder cents are distributed one at a time in lineId
// lexicographic order, so ties (same amount, same tax) always resolve
// identically regardless of input ordering.

const byLineId = (a, b) => (a.lineId < b.lineId ? -1 : a.lineId > b.lineId ? 1 : 0);

export function apportion(total, items) {
  if (!Number.isInteger(total)) throw new Error('total must be an integer');
  const sorted = [...items].sort(byLineId);
  const shares = new Map();
  if (sorted.length === 0) return shares;

  const sum = sorted.reduce((s, it) => s + it.amount, 0);
  if (sum <= 0) {
    // Degenerate case: no weight to proportion by. Split evenly, remainder
    // to the first lines in lineId order.
    const base = Math.floor(total / sorted.length);
    let rem = total - base * sorted.length;
    for (const it of sorted) shares.set(it.lineId, base + (rem-- > 0 ? 1 : 0));
    return shares;
  }

  let allocated = 0;
  const floors = sorted.map((it) => {
    const f = Math.floor((total * it.amount) / sum);
    allocated += f;
    return f;
  });
  let rem = total - allocated; // always 0 <= rem < sorted.length
  sorted.forEach((it, idx) => {
    shares.set(it.lineId, floors[idx] + (rem-- > 0 ? 1 : 0));
  });
  return shares;
}
