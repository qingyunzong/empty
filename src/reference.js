// Independent reference implementation used by the tests: it plainly
// enumerates all live trades and accumulates, with no incremental state.
export function referenceLiveTrades(trades) {
  return trades.filter((t) => t.state === 'active');
}

export function round6(v) {
  return Math.round(v * 1e6) / 1e6;
}

export function referencePair(trades, a, b, rate) {
  const [x, y] = [a, b].sort();
  let net = 0;
  for (const t of referenceLiveTrades(trades)) {
    if (t.buyer === x && t.seller === y) net -= t.amount;
    else if (t.buyer === y && t.seller === x) net += t.amount;
  }
  const payer = net > 0 ? y : net < 0 ? x : null;
  const payee = net > 0 ? x : net < 0 ? y : null;
  return { net, payer, payee, margin: round6(Math.abs(net) * rate) };
}

export function referenceFrozen(trades, rate) {
  const frozen = new Map();
  const seen = new Set();
  for (const t of referenceLiveTrades(trades)) {
    const key = [t.buyer, t.seller].sort().join('');
    if (seen.has(key)) continue;
    seen.add(key);
    const ref = referencePair(trades, t.buyer, t.seller, rate);
    if (ref.payer && ref.margin > 0) {
      frozen.set(ref.payer, round6((frozen.get(ref.payer) ?? 0) + ref.margin));
    }
  }
  return frozen;
}
