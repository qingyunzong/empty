"""NFA with epsilon edges and integer-interval symbol edges.

The NFA is mutable.  Every mutation is recorded in a monotonically
growing change log so that derived structures (closure index, lazy DFA)
can invalidate exactly what depends on the changed edges.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Dict, List, Optional, Set


@dataclass(frozen=True)
class Edge:
    id: int
    src: int
    dst: int
    lo: Optional[int] = None  # None means epsilon
    hi: Optional[int] = None

    @property
    def is_epsilon(self) -> bool:
        return self.lo is None

    def to_json(self) -> dict:
        if self.is_epsilon:
            return {"id": self.id, "from": self.src, "to": self.dst,
                    "epsilon": True}
        return {"id": self.id, "from": self.src, "to": self.dst,
                "lo": self.lo, "hi": self.hi}


class NFA:
    def __init__(self, num_states: int, start: int, accepting=()):
        if not 0 <= start < num_states:
            raise ValueError("start state out of range")
        self.num_states = num_states
        self.start = start
        self.accepting: Set[int] = set(accepting)
        for s in self.accepting:
            if not 0 <= s < num_states:
                raise ValueError("accepting state out of range")
        self._edges: Dict[int, Edge] = {}
        self._next_edge_id = 0
        self._out_sym: Dict[int, List[int]] = {s: [] for s in range(num_states)}
        self._out_eps: Dict[int, List[int]] = {s: [] for s in range(num_states)}
        # Monotonic counters consumed by derived structures.
        self.version = 0
        self.eps_version = 0
        # Change log entries: (kind, edge_id, {src, dst})
        # kind is "eps" or "symbol".
        self.change_log: List[tuple] = []

    # ------------------------------------------------------------------
    def _check_state(self, s: int) -> None:
        if not 0 <= s < self.num_states:
            raise ValueError(f"state {s} out of range")

    def add_edge(self, src: int, dst: int,
                 lo: Optional[int] = None,
                 hi: Optional[int] = None) -> int:
        """Add an edge.  lo/hi both None -> epsilon edge.  Returns edge id."""
        self._check_state(src)
        self._check_state(dst)
        if (lo is None) != (hi is None):
            raise ValueError("lo and hi must both be set or both be None")
        if lo is not None and lo > hi:
            raise ValueError("lo must be <= hi")
        eid = self._next_edge_id
        self._next_edge_id += 1
        edge = Edge(eid, src, dst, lo, hi)
        self._edges[eid] = edge
        if edge.is_epsilon:
            self._out_eps[src].append(eid)
            self.eps_version += 1
            self.change_log.append(("eps", eid, {src, dst}))
        else:
            self._out_sym[src].append(eid)
            self.change_log.append(("symbol", eid, {src}))
        self.version += 1
        return eid

    def add_symbol_edge(self, src, dst, lo, hi) -> int:
        return self.add_edge(src, dst, lo, hi)

    def add_epsilon(self, src, dst) -> int:
        return self.add_edge(src, dst)

    def remove_edge(self, edge_id: int) -> None:
        edge = self._edges.pop(edge_id, None)
        if edge is None:
            raise KeyError(f"no edge with id {edge_id}")
        if edge.is_epsilon:
            self._out_eps[edge.src].remove(edge_id)
            self.eps_version += 1
            self.change_log.append(("eps", edge_id, {edge.src, edge.dst}))
        else:
            self._out_sym[edge.src].remove(edge_id)
            self.change_log.append(("symbol", edge_id, {edge.src}))
        self.version += 1

    # ------------------------------------------------------------------
    def symbol_edges_from(self, state: int) -> List[Edge]:
        return [self._edges[i] for i in self._out_sym[state]]

    def epsilon_edges_from(self, state: int) -> List[Edge]:
        return [self._edges[i] for i in self._out_eps[state]]

    def edge(self, edge_id: int) -> Edge:
        return self._edges[edge_id]

    # ------------------------------------------------------------------
    def to_json(self) -> dict:
        return {
            "states": self.num_states,
            "start": self.start,
            "accepting": sorted(self.accepting),
            "edges": [self._edges[i].to_json() for i in sorted(self._edges)],
            "version": self.version,
            "eps_version": self.eps_version,
            "next_edge_id": self._next_edge_id,
        }

    @classmethod
    def from_json(cls, data: dict) -> "NFA":
        nfa = cls(data["states"], data["start"], data.get("accepting", []))
        max_id = -1
        for e in data.get("edges", []):
            if e.get("epsilon"):
                eid = nfa.add_edge(e["from"], e["to"])
            else:
                eid = nfa.add_edge(e["from"], e["to"], e["lo"], e["hi"])
            max_id = max(max_id, eid)
        # Loading a spec is construction, not a mutation: clear the log so
        # derived structures treat the load as a clean baseline.  The
        # version counters keep their natural values (one bump per edge)
        # unless the spec explicitly carries them, so two specs describing
        # different graphs cannot share a checkpoint.
        nfa.change_log.clear()
        nfa.version = data.get("version", nfa.version)
        nfa.eps_version = data.get("eps_version", nfa.eps_version)
        nfa._next_edge_id = data.get("next_edge_id", max_id + 1)
        return nfa
