"""PN-Counter CRDT with tombstone-based node removal.

Model
-----
- Up to 10 nodes; each node owns one slot in every replica's P/N vectors.
- inc/dec(node, k) require k > 0 and a live node, otherwise BAD_DELTA / REMOVED.
- value(replica) = sum(P) - sum(N), including contributions of removed nodes
  that the replica had already observed (causally known before removal).
- remove_node(n) requires a strict majority of the currently live nodes to
  agree (simulated: every other live node votes yes, so removal needs at
  least 3 live nodes).  After removal the node keeps a tombstone replica:
  its historical increments still merge, but new writes return REMOVED.
- Retired IDs can never be reused: membership operations on a retired ID
  return ID_RETIRED; a new node must join under a fresh ID.
- merge(dst, src) is pointwise max per slot: commutative, associative and
  idempotent, and never drops causally-known increments of removed nodes.
"""

from __future__ import annotations

MAX_NODES = 10


class ClusterError(Exception):
    """Domain error carrying a stable machine-readable code."""

    def __init__(self, code: str):
        super().__init__(code)
        self.code = code


class PNCounter:
    """Single replica state: two grow-only maps slot -> count."""

    __slots__ = ("p", "n")

    def __init__(self) -> None:
        self.p: dict[str, int] = {}
        self.n: dict[str, int] = {}

    def inc(self, slot: str, k: int) -> None:
        self.p[slot] = self.p.get(slot, 0) + k

    def dec(self, slot: str, k: int) -> None:
        self.n[slot] = self.n.get(slot, 0) + k

    def value(self) -> int:
        return sum(self.p.values()) - sum(self.n.values())

    def merge(self, other: "PNCounter") -> "PNCounter":
        for slot, count in other.p.items():
            if count > self.p.get(slot, 0):
                self.p[slot] = count
        for slot, count in other.n.items():
            if count > self.n.get(slot, 0):
                self.n[slot] = count
        return self

    def copy(self) -> "PNCounter":
        dup = PNCounter()
        dup.p = dict(self.p)
        dup.n = dict(self.n)
        return dup


def _norm_node(node) -> str:
    if isinstance(node, bool) or not isinstance(node, (str, int)):
        raise ClusterError("BAD_ARGS")
    return str(node)


def _norm_delta(k) -> int:
    if isinstance(k, bool) or not isinstance(k, int) or k <= 0:
        raise ClusterError("BAD_DELTA")
    return k


class Cluster:
    """Simulated cluster of PN-Counter replicas with membership control."""

    def __init__(self) -> None:
        # Tombstone replicas are kept after removal so historical deltas
        # remain mergeable and value queries stay well defined.
        self.replicas: dict[str, PNCounter] = {}
        self.alive: set[str] = set()
        self.retired: set[str] = set()

    # -- membership ------------------------------------------------------

    def _join(self, node: str) -> None:
        if len(self.alive) >= MAX_NODES:
            raise ClusterError("TOO_MANY_NODES")
        self.replicas[node] = PNCounter()
        self.alive.add(node)

    def remove(self, node) -> None:
        node = _norm_node(node)
        if node in self.retired:
            raise ClusterError("ID_RETIRED")
        if node not in self.alive:
            raise ClusterError("NOT_FOUND")
        live = len(self.alive)
        yes_votes = live - 1  # every other live node agrees (simulation)
        if yes_votes < live // 2 + 1:
            raise ClusterError("NO_MAJORITY")
        self.alive.discard(node)
        self.retired.add(node)

    # -- writes ----------------------------------------------------------

    def _bump(self, node, k, kind: str) -> int:
        node = _norm_node(node)
        k = _norm_delta(k)
        if node in self.replicas:
            if node not in self.alive:
                raise ClusterError("REMOVED")
        else:
            if node in self.retired:
                raise ClusterError("ID_RETIRED")
            self._join(node)
        replica = self.replicas[node]
        if kind == "p":
            replica.inc(node, k)
        else:
            replica.dec(node, k)
        return replica.value()

    def inc(self, node, k) -> int:
        return self._bump(node, k, "p")

    def dec(self, node, k) -> int:
        return self._bump(node, k, "n")

    # -- reads / replication ---------------------------------------------

    def value(self, node) -> int:
        node = _norm_node(node)
        if node not in self.replicas:
            raise ClusterError("NOT_FOUND")
        return self.replicas[node].value()

    def merge(self, dst, src) -> int:
        dst = _norm_node(dst)
        src = _norm_node(src)
        if dst not in self.replicas or src not in self.replicas:
            raise ClusterError("NOT_FOUND")
        # Tombstone replicas may be sources (historical deltas) and passive
        # destinations; merge is pointwise max, so nothing is ever lost.
        self.replicas[dst].merge(self.replicas[src])
        return self.replicas[dst].value()
