export function round6(x) {
  const r = Math.round(x * 1e6) / 1e6;
  return r === 0 ? 0 : r;
}

export function zeroEntry() {
  return { bought: 0, sold: 0, frozenShares: 0, frozenCash: 0, proceeds: 0 };
}

export function isZeroEntry(e) {
  return e.bought === 0 && e.sold === 0 && e.frozenShares === 0 && e.frozenCash === 0 && e.proceeds === 0;
}

export function normalizeEntry(e) {
  return {
    bought: e.bought,
    sold: e.sold,
    frozenShares: e.frozenShares,
    frozenCash: round6(e.frozenCash),
    proceeds: round6(e.proceeds),
    netShares: e.bought - e.sold,
  };
}
