// Relational-algebra primitives used to express the bitemporal filter.
// A "relation" here is a plain array of normalized events.

// σ predicate (relation)
export function select(relation, predicate) {
  return relation.filter(predicate);
}

// left ⋉̸ right  (anti-join): tuples of left with NO partner in right.
export function antiJoin(left, right, matches) {
  return left.filter((l) => !right.some((r) => matches(l, r)));
}

// Valid-time predicate: validFrom inclusive, validTo exclusive.
// NULL validTo means "currently valid" (open interval).
export function inValidTime(event, validMs) {
  return event.validFromMs <= validMs
    && (event.validToMs === null || event.validToMs > validMs);
}

// Transaction-time predicate: the version was recorded at or before txSeq.
export function inTxTime(event, txSeq) {
  return event.txSeq <= txSeq;
}

// Bitemporal visibility as a relational expression:
//   known  = σ account,tx≤N (events)
//   heads  = known ⋉̸ { newer version in same chain with tx≤N }   (anti-join)
//   result = σ ¬tombstone ∧ valid-time (heads)
// Corrections are append-only: the old version stays in `events`,
// it is simply anti-joined away once a newer version of its chain exists.
export function visibleVersions(events, account, validMs, txSeq) {
  const known = select(events, (e) => e.account === account && inTxTime(e, txSeq));
  const heads = antiJoin(known, known,
    (a, b) => a.root === b.root && b.txSeq > a.txSeq);
  return select(heads, (e) => !e.tombstone && inValidTime(e, validMs));
}
