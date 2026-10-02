import { RefundError } from './errors.js';

const byLineId = (a, b) => (a.lineId < b.lineId ? -1 : a.lineId > b.lineId ? 1 : 0);

// Split integer `total` across entries proportional to their integer `amount`.
// Floor shares first; remaining units go to the largest fractional remainders.
// Ties (equal amount => equal remainder) break by lineId lexicographic order,
// so the result is deterministic and independent of input order.
export function allocate(total, entries) {
  if (!Number.isInteger(total) || total < 0) {
    throw new RefundError('E_VALIDATION', `total must be a non-negative integer, got ${total}`);
  }
  const items = entries.map((e) => {
    if (!Number.isInteger(e.amount) || e.amount < 0) {
      throw new RefundError('E_VALIDATION', `amount for ${e.lineId} must be a non-negative integer`);
    }
    return { lineId: String(e.lineId), amount: e.amount };
  });
  const result = new Map();
  if (items.length === 0) {
    if (total !== 0) throw new RefundError('E_VALIDATION', 'cannot allocate a non-zero total to zero entries');
    return result;
  }
  const sum = items.reduce((acc, it) => acc + it.amount, 0);
  if (sum === 0) {
    const sorted = [...items].sort(byLineId);
    const base = Math.floor(total / sorted.length);
    let rem = total - base * sorted.length;
    for (const it of sorted) result.set(it.lineId, base + (rem-- > 0 ? 1 : 0));
    return result;
  }
  let assigned = 0;
  const rows = items.map((it) => {
    const numerator = total * it.amount;
    const q = Math.floor(numerator / sum);
    const r = numerator - q * sum; // 0 <= r < sum, common denominator
    assigned += q;
    return { lineId: it.lineId, q, r };
  });
  let rem = total - assigned;
  rows.sort((a, b) => b.r - a.r || byLineId(a, b));
  for (const row of rows) result.set(row.lineId, row.q + (rem-- > 0 ? 1 : 0));
  return result;
}
