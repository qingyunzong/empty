'use strict';

// Multilateral netting for a single currency.
// obligations: [{ from, to, amount(BigInt) }] (same ccy)
// Returns gross bilateral matrix and signed net position per bank
// (positive = net receiver, negative = net payer).
function computeNetting(obligations) {
  const matrix = new Map(); // "from->to" -> BigInt gross
  const net = new Map(); // bank id -> BigInt
  for (const o of obligations) {
    const k = `${o.from}->${o.to}`;
    matrix.set(k, (matrix.get(k) || 0n) + o.amount);
    net.set(o.from, (net.get(o.from) || 0n) - o.amount);
    net.set(o.to, (net.get(o.to) || 0n) + o.amount);
  }
  return { matrix, net };
}

module.exports = { computeNetting };
