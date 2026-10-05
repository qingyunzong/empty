export function ev(id, account, amount, direction, currency, relId) {
  return { id, account, amount, direction, currency, relId };
}

// A balanced debit/credit pair sharing one relId.
export function pair(idA, idB, { amount = 100, currency = 'USD', relId = 'r1', accD = 'cash', accC = 'revenue' } = {}) {
  return [
    ev(idA, accD, amount, 'debit', currency, relId),
    ev(idB, accC, amount, 'credit', currency, relId),
  ];
}

// Deterministic PRNG (mulberry32) for reproducible enumeration tests.
export function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
