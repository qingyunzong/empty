"""PN-Counter CRDT with node removal (tombstones) and majority-vote membership.

Semantics:
- inc/dec(node, k): only live members may write; k must be a positive int,
  otherwise BAD_DELTA.
- value() = sum(P) - sum(N), including contributions of removed nodes that
  were causally observed.
- remove_node(n, voters): requires a strict majority of live members as
  voters. Afterwards writes to n return REMOVED, but its historical
  increments still merge.
- merge is commutative, associative and idempotent, and never drops
  causally-known increments of removed nodes.
- Rejoining with a retired ID returns ID_RETIRED; a new node needs a new ID.
"""

MAX_NODES = 10


class PNCounterError(Exception):
    code = "ERROR"

    def __init__(self, message=""):
        super().__init__(message or self.code)


class BadDelta(PNCounterError):
    code = "BAD_DELTA"


class RemovedNode(PNCounterError):
    code = "REMOVED"


class IdRetired(PNCounterError):
    code = "ID_RETIRED"


class IdTaken(PNCounterError):
    code = "ID_TAKEN"


class NoMajority(PNCounterError):
    code = "NO_MAJORITY"


class UnknownNode(PNCounterError):
    code = "UNKNOWN_NODE"


class NodeLimit(PNCounterError):
    code = "NODE_LIMIT"


def _valid_delta(k):
    return isinstance(k, int) and not isinstance(k, bool) and k > 0


class PNCounter:
    """State-based PN-Counter with tombstone-based node removal."""

    def __init__(self):
        self.p = {}          # node -> positive count (grow-only)
        self.n = {}          # node -> negative count (grow-only)
        self.members = set()  # live node ids
        self.retired = set()  # tombstoned node ids (never resurrected)

    def add_node(self, node):
        if node in self.retired:
            raise IdRetired(node)
        if node in self.members:
            raise IdTaken(node)
        if len(self.members) >= MAX_NODES:
            raise NodeLimit(node)
        self.members.add(node)
        self.p.setdefault(node, 0)
        self.n.setdefault(node, 0)

    def inc(self, node, k):
        self._bump(node, k, self.p)

    def dec(self, node, k):
        self._bump(node, k, self.n)

    def _bump(self, node, k, vec):
        if not _valid_delta(k):
            raise BadDelta(repr(k))
        if node in self.retired:
            raise RemovedNode(node)
        if node not in self.members:
            raise UnknownNode(node)
        vec[node] = vec.get(node, 0) + k

    def value(self):
        return sum(self.p.values()) - sum(self.n.values())

    def remove_node(self, node, voters):
        """Remove `node` given a strict majority of live members as voters."""
        if node in self.retired:
            raise RemovedNode(node)
        if node not in self.members:
            raise UnknownNode(node)
        unique_voters = set(voters)
        for v in unique_voters:
            if v not in self.members:
                raise UnknownNode(v)
        if len(unique_voters) * 2 <= len(self.members):
            raise NoMajority(node)
        self.members.discard(node)
        self.retired.add(node)

    def merge(self, other):
        """Merge a copy of `other` into self. Never mutates `other`."""
        for vec, other_vec in ((self.p, other.p), (self.n, other.n)):
            for node, count in other_vec.items():
                if count > vec.get(node, 0):
                    vec[node] = count
        self.retired |= other.retired
        self.members = (self.members | other.members) - self.retired
        return self

    def copy(self):
        clone = PNCounter()
        clone.p = dict(self.p)
        clone.n = dict(self.n)
        clone.members = set(self.members)
        clone.retired = set(self.retired)
        return clone

    def state(self):
        return {
            "p": dict(self.p),
            "n": dict(self.n),
            "members": sorted(self.members),
            "retired": sorted(self.retired),
        }

    def __eq__(self, other):
        return (
            isinstance(other, PNCounter)
            and self.p == other.p
            and self.n == other.n
            and self.members == other.members
            and self.retired == other.retired
        )
