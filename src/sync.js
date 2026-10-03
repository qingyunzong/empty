// Bidirectional sync driven by version vectors. Each store advertises
// vv = { site: maxSeq }; a peer sends exactly the entries the other side
// is missing per site. Entry ids make re-delivery idempotent.
export function missingFor(source, peerVV) {
  return source.entries
    .filter((e) => (e.seq || 0) > (peerVV[e.site] || 0))
    .sort((a, b) => (a.site < b.site ? -1 : a.site > b.site ? 1 : a.seq - b.seq));
}

export function syncStores(a, b) {
  const vvA = { ...a.graph.vv };
  const vvB = { ...b.graph.vv };
  const toB = missingFor(a, vvB);
  const toA = missingFor(b, vvA);
  const receivedA = a.receive(toA);
  const receivedB = b.receive(toB);
  return {
    sentToPeer: toB.length,
    receivedFromPeer: toA.length,
    appliedA: receivedA,
    appliedB: receivedB,
    vvA: a.graph.vv,
    vvB: b.graph.vv,
    pendingA: a.graph.pending.length,
    pendingB: b.graph.pending.length,
    converged: (() => {
      const sites = new Set([...Object.keys(a.graph.vv), ...Object.keys(b.graph.vv)]);
      return [...sites].every((s) => (a.graph.vv[s] || 0) === (b.graph.vv[s] || 0));
    })(),
  };
}
