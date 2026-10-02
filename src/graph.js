// Directed debt graph per currency. Parallel obligations between the same
// ordered pair of members are aggregated into one edge; the contributing
// obligation ids are retained so the proof can attribute every cent.
export function buildGraphs(obligations) {
  const byCcy = new Map();
  for (const ob of obligations) {
    let g = byCcy.get(ob.ccy);
    if (!g) {
      g = { ccy: ob.ccy, members: new Set(), edges: new Map(), positions: new Map() };
      byCcy.set(ob.ccy, g);
    }
    g.members.add(ob.debtor);
    g.members.add(ob.creditor);
    const key = ob.debtor + '→' + ob.creditor;
    let e = g.edges.get(key);
    if (!e) {
      e = { from: ob.debtor, to: ob.creditor, amount: 0, obs: [] };
      g.edges.set(key, e);
    }
    e.amount += ob.amount;
    e.obs.push(ob.id);
    g.positions.set(ob.creditor, (g.positions.get(ob.creditor) || 0) + ob.amount);
    g.positions.set(ob.debtor, (g.positions.get(ob.debtor) || 0) - ob.amount);
  }
  return byCcy;
}
