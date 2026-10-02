export function pairKey(a, b) {
  return [a, b].sort().join('');
}

// Net obligation from the canonical (alphabetically first) party's view:
// a trade where x buys means x owes the amount, where x sells means x is owed.
export function computeNet(trades, a, b) {
  const [x, y] = [a, b].sort();
  let net = 0;
  for (const t of trades) {
    if (t.state !== 'active') continue;
    const isPair =
      (t.buyer === x && t.seller === y) || (t.buyer === y && t.seller === x);
    if (!isPair) continue;
    net += t.buyer === x ? -t.amount : t.amount;
  }
  const payer = net > 0 ? y : net < 0 ? x : null;
  const payee = net > 0 ? x : net < 0 ? y : null;
  return { net, payer, payee };
}
