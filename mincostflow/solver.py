"""Min-cost circulation solver.

Model
-----
Directed graph. Each edge has a unique id, integer lower/upper bounds
``lo <= hi`` and an integer cost (negative costs allowed). Each node has an
integer demand ``d(v)``: a feasible flow satisfies
``inflow(v) - outflow(v) == d(v)`` at every node, hence demands must sum to 0.

Algorithm
---------
Feasibility is decided first by a max-flow repair phase on the residual
network of the *current* flow (never rebuilt from scratch), then cost is
optimized by negative-cycle cancelling (Bellman-Ford). Optimality is proven
by node potentials with non-negative reduced costs on every residual arc.

A ``budget`` bounds the number of work units (each augmenting path and each
Bellman-Ford pass costs one unit). If the budget is exhausted the solver
reports ``feasible`` + ``not_proven`` and never claims optimality. Calling
:meth:`solve` again resumes from the retained flow, so pause/resume works.

Batch updates (bounds, demands, costs) are validated atomically before any
mutation; on error nothing changes, including the last published feasible
version, which is kept separately and survives infeasible solves.
"""

from __future__ import annotations

from collections import deque
from dataclasses import dataclass
from typing import Optional

from .model import Edge, normalize_edges

FEASIBLE = "feasible"
INFEASIBLE = "infeasible"
UNKNOWN = "unknown"
OPTIMAL = "optimal"
NOT_PROVEN = "not_proven"

_SOURCE = "\x00source"
_SINK = "\x00sink"


class UpdateError(ValueError):
    """Raised when a batch update is invalid; no state is changed."""


@dataclass
class SolveResult:
    feasibility: str               # feasible | infeasible | unknown
    optimality: str                # optimal | not_proven | infeasible | unknown
    flows: Optional[dict] = None           # edge id -> flow (when feasible)
    potentials: Optional[dict] = None      # node -> potential (only when optimal)
    cost: Optional[int] = None
    certificate: Optional[list] = None     # node set witnessing infeasibility
    budget_remaining: Optional[int] = None

    def to_dict(self) -> dict:
        return {
            "feasibility": self.feasibility,
            "optimality": self.optimality,
            "flows": self.flows,
            "potentials": self.potentials,
            "cost": self.cost,
            "certificate": self.certificate,
            "budget_remaining": self.budget_remaining,
        }


class MinCostCirculation:
    def __init__(self, nodes, edges, demands=None):
        self.nodes = [str(n) for n in nodes]
        if len(set(self.nodes)) != len(self.nodes):
            raise ValueError("duplicate node names")
        self._node_set = set(self.nodes)
        self.edges: dict[str, Edge] = {}
        for e in normalize_edges(edges):
            self._check_edge(e)
            if e.id in self.edges:
                raise ValueError(f"duplicate edge id: {e.id!r}")
            self.edges[e.id] = e
        self.demands = {v: 0 for v in self.nodes}
        for v, val in (demands or {}).items():
            if v not in self._node_set:
                raise ValueError(f"demand for unknown node: {v!r}")
            self.demands[v] = self._as_int(val, f"demand[{v!r}]")
        if sum(self.demands.values()) != 0:
            raise ValueError("demands must sum to zero")
        # Current flow: start at lower bounds; repaired incrementally later.
        self.flow = {eid: e.lo for eid, e in self.edges.items()}
        # Last published feasible version; survives later infeasible solves.
        self.published: Optional[SolveResult] = None

    # ------------------------------------------------------------------ #
    # validation helpers

    @staticmethod
    def _as_int(value, what):
        if isinstance(value, bool) or not isinstance(value, int):
            raise UpdateError(f"{what} must be an integer, got {value!r}")
        return value

    def _check_edge(self, e: Edge):
        for name, val in (("lo", e.lo), ("hi", e.hi), ("cost", e.cost)):
            if isinstance(val, bool) or not isinstance(val, int):
                raise ValueError(f"edge {e.id!r}: {name} must be an integer")
        for endpoint in (e.tail, e.head):
            if endpoint not in self._node_set:
                raise ValueError(f"edge {e.id!r}: unknown endpoint {endpoint!r}")
        if e.lo > e.hi:
            raise ValueError(f"edge {e.id!r}: lo ({e.lo}) > hi ({e.hi})")

    # ------------------------------------------------------------------ #
    # state inspection

    def snapshot(self) -> dict:
        return {
            "edges": {eid: (e.lo, e.hi, e.cost) for eid, e in self.edges.items()},
            "demands": dict(self.demands),
            "flows": dict(self.flow),
            "published": None if self.published is None else self.published.to_dict(),
        }

    def total_cost(self) -> int:
        return sum(self.flow[eid] * e.cost for eid, e in self.edges.items())

    # ------------------------------------------------------------------ #
    # atomic batch updates

    def apply_updates(self, edge_updates=None, demand_updates=None):
        """Apply a batch of bound/cost/demand changes atomically.

        ``edge_updates``: {edge_id: {"lo":.., "hi":.., "cost":..}} (any subset
        of fields). ``demand_updates``: {node: new_demand}. Everything is
        validated before any mutation; on :class:`UpdateError` the solver
        state (flows, bounds, demands, published version) is unchanged.
        The current flow is kept and repaired by the next :meth:`solve`.
        """
        edge_updates = edge_updates or {}
        demand_updates = demand_updates or {}

        staged = {}
        for eid, fields in edge_updates.items():
            if eid not in self.edges:
                raise UpdateError(f"unknown edge id: {eid!r}")
            if not isinstance(fields, dict):
                raise UpdateError(f"edge update for {eid!r} must be a mapping")
            unknown = set(fields) - {"lo", "hi", "cost"}
            if unknown:
                raise UpdateError(f"edge {eid!r}: unknown fields {sorted(unknown)}")
            e = self.edges[eid]
            lo = self._as_int(fields.get("lo", e.lo), f"{eid!r}.lo")
            hi = self._as_int(fields.get("hi", e.hi), f"{eid!r}.hi")
            cost = self._as_int(fields.get("cost", e.cost), f"{eid!r}.cost")
            if lo > hi:
                raise UpdateError(f"edge {eid!r}: lo ({lo}) > hi ({hi})")
            staged[eid] = (lo, hi, cost)

        new_demands = dict(self.demands)
        for v, val in demand_updates.items():
            if v not in self._node_set:
                raise UpdateError(f"demand for unknown node: {v!r}")
            new_demands[v] = self._as_int(val, f"demand[{v!r}]")
        if sum(new_demands.values()) != 0:
            raise UpdateError("demands must sum to zero after update")

        # All validation passed: commit.
        for eid, (lo, hi, cost) in staged.items():
            e = self.edges[eid]
            e.lo, e.hi, e.cost = lo, hi, cost
        self.demands = new_demands

    # ------------------------------------------------------------------ #
    # residual network helpers

    def _residual_arcs(self):
        """Yield (u, v, cap, cost, edge_id, direction) for cap > 0 arcs."""
        for e in self.edges.values():
            f = self.flow[e.id]
            if f < e.hi:
                yield (e.tail, e.head, e.hi - f, e.cost, e.id, 1)
            if f > e.lo:
                yield (e.head, e.tail, f - e.lo, -e.cost, e.id, -1)

    def _clamp_flows(self):
        for e in self.edges.values():
            f = self.flow[e.id]
            if f < e.lo:
                self.flow[e.id] = e.lo
            elif f > e.hi:
                self.flow[e.id] = e.hi

    def _excesses(self):
        """exc(v) = inflow(v) - outflow(v) - demand(v); feasible iff all 0."""
        exc = {v: -self.demands[v] for v in self.nodes}
        for e in self.edges.values():
            f = self.flow[e.id]
            exc[e.tail] -= f
            exc[e.head] += f
        return exc

    # ------------------------------------------------------------------ #
    # feasibility phase (max-flow repair on the residual network)

    def _repair_feasibility(self, budget):
        """Returns (used, outcome): outcome is None (feasible), UNKNOWN, or a
        cut certificate (list of nodes)."""
        self._clamp_flows()
        exc = self._excesses()
        if all(x == 0 for x in exc.values()):
            return 0, None

        graph = {v: [] for v in self.nodes + [_SOURCE, _SINK]}
        arc_map = {}

        def add_arc(u, v, cap, key=None):
            graph[u].append([v, cap, len(graph[v])])
            graph[v].append([u, 0, len(graph[u]) - 1])
            if key is not None:
                eid, direction = key
                # Map both the arc and its reverse: augmenting paths may
                # cancel previously pushed repair flow via reverse arcs,
                # and the edge flow must stay in sync either way.
                arc_map[(u, len(graph[u]) - 1)] = (eid, direction)
                arc_map[(v, len(graph[v]) - 1)] = (eid, -direction)

        for (u, v, cap, _cost, eid, direction) in self._residual_arcs():
            add_arc(u, v, cap, key=(eid, direction))

        need = 0
        for v, x in exc.items():
            if x > 0:
                add_arc(_SOURCE, v, x)
                need += x
            elif x < 0:
                add_arc(v, _SINK, -x)

        used = 0
        pushed = 0
        while pushed < need:
            if budget is not None and used >= budget:
                return used, UNKNOWN
            parent = self._bfs_path(graph)
            if parent is None:
                break
            # bottleneck
            delta = None
            v = _SINK
            while v != _SOURCE:
                u, idx = parent[v]
                cap = graph[u][idx][1]
                delta = cap if delta is None else min(delta, cap)
                v = u
            v = _SINK
            while v != _SOURCE:
                u, idx = parent[v]
                arc = graph[u][idx]
                arc[1] -= delta
                graph[v][arc[2]][1] += delta
                if (u, idx) in arc_map:
                    eid, direction = arc_map[(u, idx)]
                    self.flow[eid] += direction * delta
                v = u
            pushed += delta
            used += 1

        if pushed < need:
            reachable = self._reachable(graph)
            outside = [v for v in self.nodes if v not in reachable]
            inside = [v for v in self.nodes if v in reachable]
            # By max-flow/min-cut, the complement of the reachable set
            # violates d(Y) > u(delta^-(Y)) - l(delta^+(Y)).
            cert = outside if self._cut_violated(outside) else inside
            return used, sorted(cert)
        # defensive: a feasible claim must be backed by zero excesses
        assert all(x == 0 for x in self._excesses().values())
        return used, None

    @staticmethod
    def _bfs_path(graph):
        parent = {_SOURCE: None}
        queue = deque([_SOURCE])
        while queue:
            u = queue.popleft()
            for idx, arc in enumerate(graph[u]):
                v, cap = arc[0], arc[1]
                if cap > 0 and v not in parent:
                    parent[v] = (u, idx)
                    if v == _SINK:
                        return parent
                    queue.append(v)
        return None

    @staticmethod
    def _reachable(graph):
        seen = {_SOURCE}
        queue = deque([_SOURCE])
        while queue:
            u = queue.popleft()
            for arc in graph[u]:
                if arc[1] > 0 and arc[0] not in seen:
                    seen.add(arc[0])
                    queue.append(arc[0])
        return seen

    def _cut_violated(self, nodeset) -> bool:
        s = set(nodeset)
        demand = sum(self.demands[v] for v in s)
        cap_in = sum(e.hi for e in self.edges.values()
                     if e.head in s and e.tail not in s)
        lo_out = sum(e.lo for e in self.edges.values()
                     if e.tail in s and e.head not in s)
        return demand > cap_in - lo_out

    # ------------------------------------------------------------------ #
    # optimization phase (negative-cycle cancelling)

    def _bellman_ford(self):
        """Returns (cycle, dist). cycle is a list of residual arcs or None."""
        dist = {v: 0 for v in self.nodes}
        parent = {}
        arcs = list(self._residual_arcs())
        n = len(self.nodes)
        updated = None
        for _ in range(n):
            updated = None
            for (u, v, cap, cost, eid, direction) in arcs:
                if dist[u] + cost < dist[v]:
                    dist[v] = dist[u] + cost
                    parent[v] = (u, v, cap, cost, eid, direction)
                    updated = v
            if updated is None:
                break
        if updated is None:
            return None, dist
        v = updated
        for _ in range(n):
            v = parent[v][0]
        cycle = []
        cur = v
        while True:
            arc = parent[cur]
            cycle.append(arc)
            cur = arc[0]
            if cur == v:
                break
        return cycle, dist

    def _optimize(self, budget):
        """Returns (used, potentials). potentials is None when the budget ran
        out before optimality could be proven."""
        used = 0
        while True:
            if budget is not None and used >= budget:
                return used, None
            used += 1  # one Bellman-Ford pass
            cycle, dist = self._bellman_ford()
            if cycle is None:
                return used, dict(dist)
            delta = min(arc[2] for arc in cycle)
            for (_u, _v, _cap, _cost, eid, direction) in cycle:
                self.flow[eid] += direction * delta

    # ------------------------------------------------------------------ #
    # main entry point

    def solve(self, budget: Optional[int] = None) -> SolveResult:
        """Repair feasibility from the current flow, then optimize cost.

        ``budget`` bounds work units (augmenting paths + Bellman-Ford
        passes); None means unlimited. Never discards state: repeated calls
        resume from the retained flow and residual network.
        """
        if budget is not None:
            self._as_int(budget, "budget")
            if budget < 0:
                raise ValueError("budget must be >= 0")
        rem = budget

        used, outcome = self._repair_feasibility(rem)
        if rem is not None:
            rem -= used

        if outcome == UNKNOWN:
            return SolveResult(UNKNOWN, UNKNOWN, budget_remaining=rem)
        if isinstance(outcome, list):
            # Infeasible: published feasible version is left untouched.
            return SolveResult(INFEASIBLE, INFEASIBLE,
                               certificate=outcome, budget_remaining=rem)

        used, potentials = self._optimize(rem)
        if rem is not None:
            rem -= used

        flows = dict(self.flow)
        cost = self.total_cost()
        if potentials is None:
            result = SolveResult(FEASIBLE, NOT_PROVEN, flows=flows,
                                 potentials=None, cost=cost,
                                 budget_remaining=rem)
        else:
            result = SolveResult(FEASIBLE, OPTIMAL, flows=flows,
                                 potentials=potentials, cost=cost,
                                 budget_remaining=rem)
        # Publish only feasible results; infeasible solves keep the old one.
        self.published = SolveResult(
            feasibility=result.feasibility,
            optimality=result.optimality,
            flows=dict(result.flows),
            potentials=None if result.potentials is None else dict(result.potentials),
            cost=result.cost,
            certificate=None,
            budget_remaining=result.budget_remaining,
        )
        return result

    def published_result(self) -> Optional[SolveResult]:
        """The last published feasible version (None if never feasible)."""
        return self.published
