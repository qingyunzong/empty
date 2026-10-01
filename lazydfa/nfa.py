"""NFA with epsilon edges and integer-interval symbol transitions.

An edge is either an epsilon edge (``lo is None and hi is None``) or a
symbol edge carrying an inclusive integer interval ``[lo, hi]``.  The
character domain is never enumerated; intervals are the atomic unit.
"""
from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True)
class Edge:
    id: int
    src: int
    dst: int
    lo: int | None = None
    hi: int | None = None

    @property
    def is_epsilon(self) -> bool:
        return self.lo is None

    def to_dict(self) -> dict:
        return {"id": self.id, "src": self.src, "dst": self.dst,
                "lo": self.lo, "hi": self.hi}

    @staticmethod
    def from_dict(data: dict) -> "Edge":
        return Edge(id=data["id"], src=data["src"], dst=data["dst"],
                    lo=data["lo"], hi=data["hi"])


class NFA:
    """Mutable NFA.  Mutation listeners are notified so that derived
    structures (lazy DFA, closure index) can invalidate incrementally."""

    def __init__(self, num_states: int, start: int, finals=()):
        if not 0 <= start < num_states:
            raise ValueError("start state out of range")
        self.num_states = num_states
        self.start = start
        self.finals = frozenset(finals)
        for f in self.finals:
            if not 0 <= f < num_states:
                raise ValueError("final state out of range")
        self.edges: dict[int, Edge] = {}
        self._out: list[set[int]] = [set() for _ in range(num_states)]
        self._next_edge_id = 0
        # `version` bumps on every mutation; `eps_version` only on
        # epsilon-edge mutations (drives closure-index recomputation).
        self.version = 0
        self.eps_version = 0
        self._listeners: list = []

    def add_listener(self, listener) -> None:
        self._listeners.append(listener)

    def add_edge(self, src: int, dst: int,
                 lo: int | None = None, hi: int | None = None) -> int:
        if not (0 <= src < self.num_states and 0 <= dst < self.num_states):
            raise ValueError("edge endpoint out of range")
        if (lo is None) != (hi is None):
            raise ValueError("epsilon edges must have lo=hi=None")
        if lo is not None:
            if not (isinstance(lo, int) and isinstance(hi, int)):
                raise ValueError("interval bounds must be ints")
            if lo > hi:
                raise ValueError("empty interval")
        eid = self._next_edge_id
        self._next_edge_id += 1
        edge = Edge(id=eid, src=src, dst=dst, lo=lo, hi=hi)
        self.edges[eid] = edge
        self._out[src].add(eid)
        self.version += 1
        if edge.is_epsilon:
            self.eps_version += 1
        for listener in self._listeners:
            listener.edge_added(edge)
        return eid

    def remove_edge(self, edge_id: int) -> Edge:
        edge = self.edges[edge_id]
        # Notify before removal so listeners can still inspect the edge.
        for listener in self._listeners:
            listener.edge_removed(edge)
        del self.edges[edge_id]
        self._out[edge.src].discard(edge_id)
        self.version += 1
        if edge.is_epsilon:
            self.eps_version += 1
        return edge

    def out_edges(self, state: int) -> list[Edge]:
        return [self.edges[i] for i in sorted(self._out[state])]

    def epsilon_edges(self, state: int) -> list[Edge]:
        return [e for e in self.out_edges(state) if e.is_epsilon]

    def symbol_edges(self, state: int) -> list[Edge]:
        return [e for e in self.out_edges(state) if not e.is_epsilon]

    def to_dict(self) -> dict:
        return {
            "num_states": self.num_states,
            "start": self.start,
            "finals": sorted(self.finals),
            "edges": [self.edges[i].to_dict() for i in sorted(self.edges)],
            "next_edge_id": self._next_edge_id,
            "version": self.version,
            "eps_version": self.eps_version,
        }

    @staticmethod
    def from_dict(data: dict) -> "NFA":
        nfa = NFA(data["num_states"], data["start"], data["finals"])
        for ed in data["edges"]:
            edge = Edge.from_dict(ed)
            nfa.edges[edge.id] = edge
            nfa._out[edge.src].add(edge.id)
        nfa._next_edge_id = data["next_edge_id"]
        nfa.version = data["version"]
        nfa.eps_version = data["eps_version"]
        return nfa
