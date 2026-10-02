// Fixed splitting rule: merchant 94%, fee 4%, tax 2% (basis points).
export const SPLIT_RULE = Object.freeze([
  Object.freeze({ key: 'merchant', basisPoints: 9400 }),
  Object.freeze({ key: 'fee', basisPoints: 400 }),
  Object.freeze({ key: 'tax', basisPoints: 200 }),
]);

export class SplitError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'SplitError';
    this.code = code;
  }
}

// Split `totalCents` proportionally by the rule; the rounding remainder is
// distributed one cent at a time to the largest shares (descending amount,
// ties broken by rule order). Returns { merchant, fee, tax, total }.
export function splitAmount(totalCents, rule = SPLIT_RULE) {
  if (!Number.isSafeInteger(totalCents) || totalCents < 0) {
    throw new SplitError('INVALID_AMOUNT', `total must be a non-negative integer of cents, got ${totalCents}`);
  }
  const bpSum = rule.reduce((sum, r) => sum + r.basisPoints, 0);
  if (bpSum <= 0) {
    throw new SplitError('INVALID_RULE', 'rule basis points must sum to a positive value');
  }
  const shares = rule.map((r) => ({
    key: r.key,
    amount: Math.floor((totalCents * r.basisPoints) / bpSum),
  }));
  let remainder = totalCents - shares.reduce((sum, s) => sum + s.amount, 0);
  // Array.prototype.sort is stable: equal amounts keep rule order.
  const ranked = [...shares].sort((a, b) => b.amount - a.amount);
  for (let i = 0; remainder > 0; i = (i + 1) % ranked.length) {
    ranked[i].amount += 1;
    remainder -= 1;
  }
  const result = { total: totalCents };
  for (const share of shares) result[share.key] = share.amount;
  return result;
}
