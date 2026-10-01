"""Reference serializability checker.

Determines whether a set of (committed) transactions is conflict
serializable by enumerating every serial order and testing whether at
least one of them respects all dependency edges:

  * wr dependency  W -> R : R reads a key W wrote and W committed before
    R's snapshot (R observed W's write).
  * rw antidependency R -> W : R reads a key W wrote but W committed
    after R's snapshot began (R did not observe W's write).
  * ww dependency  A -> B : both write the same key; ordered by commit
    timestamp (first-committer-wins order).

The set is serializable iff some serial order is consistent with every
edge, i.e. iff the dependency graph is acyclic.
"""

from itertools import permutations


class RefTx:
    """Lightweight transaction record for the reference checker."""

    __slots__ = ("id", "begin_ts", "commit_ts", "read_set", "write_set")

    def __init__(self, tx_id, begin_ts, commit_ts, read_set, write_set):
        self.id = tx_id
        self.begin_ts = begin_ts
        self.commit_ts = commit_ts
        self.read_set = set(read_set)
        self.write_set = set(write_set)


def dependency_edges(txs):
    edges = set()
    for r in txs:
        for w in txs:
            if r is w:
                continue
            if set(r.read_set) & set(w.write_set):
                if w.commit_ts <= r.begin_ts:
                    edges.add((w.id, r.id))  # wr: reader observed writer
                else:
                    edges.add((r.id, w.id))  # rw antidependency
    for a in txs:
        for b in txs:
            if a is b:
                continue
            if set(a.write_set) & set(b.write_set):
                earlier, later = (a, b) if a.commit_ts < b.commit_ts else (b, a)
                edges.add((earlier.id, later.id))
    return edges


def is_serializable(txs):
    """True iff some serial order of `txs` respects all dependency edges."""
    txs = list(txs)
    edges = dependency_edges(txs)
    for order in permutations(txs):
        pos = {t.id: i for i, t in enumerate(order)}
        if all(pos[a] < pos[b] for a, b in edges):
            return True
    return False
