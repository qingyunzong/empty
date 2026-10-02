"""Min-cost circulation with edge lower/upper bounds, node demands and
integer costs (negative costs allowed).

Conventions
-----------
* Every edge has a unique id, a tail, a head, an integer lower bound, an
  integer upper bound and an integer cost.
* Every node has an integer demand.  ``demand(v) > 0`` means the node must
  receive a net inflow of ``demand(v)`` units (it behaves as a sink).
  The balance constraint is ``inflow(v) - outflow(v) == demand(v)``.
* A flow is feasible iff every edge respects its bounds and every node
  satisfies its balance constraint.
* An optimal feasible flow additionally admits node potentials ``p`` such
  that for every edge ``e = (u, v)`` with reduced cost
  ``rc = cost(e) + p[u] - p[v]``:

    - ``flow(e) < upper(e)``  implies  ``rc >= 0``
    - ``flow(e) > lower(e)``  implies  ``rc <= 0``

The solver is incremental: bounds, demands and costs may be changed in
batches and the current flow / residual network is repaired instead of
being rebuilt from scratch.
"""

from __future__ import annotations

from collections import deque
from dataclasses import dataclass, field
from typing import Any, Hashable, Iterable, Optional


class UpdateError(Exception):
    """A batch of updates failed validation; no solver state was changed."""


@dataclass(frozen=True)
class Edge:
    id: Hashable
    tail: Hashable
    head: Hashable
    lower: int
    upper: int
    cost: int


@dataclass
class SolveResult:
    """Outcome of a solve call.

    ``feasible`` and ``optimal`` are independent: a budget-limited solve may
    return a feasible flow that is not proven optimal.  An infeasible model
    yields a cut certificate instead of a flow.
    """

    feasible: bool
    optimal: bool
    flow: Optional[dict] = None
    potentials: Optional[dict] = None
    cost: Optional[int] = None
    certificate: Optional[dict] = None

    def to_dict(self) -> dict:
        return {
            "feasible": self.feasible,
            "optimal": self.optimal,
            "flow": self.flow,
            "potentials": self.potentials,
            "cost": self.cost,
            "certificate": self.certificate,
        }


def _require_int(value: Any, what: str) -> int:
    if isinstance(value, bool) or not isinstance(value, int):
        raise UpdateError(f"{what} must be an integer, got {value!r}")
    return value


class MinCostCirculation:
    """Incremental min-cost circulation solver."""

    def __init__(self) -> None:
        self.demands: dict = {}
        self.edges: dict = {}
        self.flow: dict = {}
        self._out: dict = {}
        self._in: dict = {}
        self._published: Optional[SolveResult] = None
        self._cert_hint: Optional[dict] = None

    # ------------------------------------------------------------------
    # model construction
    # ------------------------------------------------------------------
    def add_node(self, node: Hashable, demand: int = 0) -> None:
        demand = _require_int(demand, "demand")
        if node in self.demands:
            raise UpdateError(f"duplicate node {node!r}")
        self.demands[node] = demand

    def add_edge(self, edge_id: Hashable, tail: Hashable, head: Hashable,
                 lower: int = 0, upper: int = 0, cost: int = 0) -> None:
        lower = _require_int(lower, "lower")
        upper = _require_int(upper, "upper")
        cost = _require_int(cost, "cost")
        if edge_id in self.edges:
            raise UpdateError(f"duplicate edge id {edge_id!r}")
        if lower < 0:
            raise UpdateError(f"lower bound must be >= 0, got {lower}")
        if upper < lower:
            raise UpdateError(f"upper bound {upper} < lower bound {lower}")
        self.demands.setdefault(tail, 0)
        self.demands.setdefault(head, 0)
        self.edges[edge_id] = Edge(edge_id, tail, head, lower, upper, cost)
        # Start at the lower bound; the next solve() rebalances the
        # resulting node imbalances through the residual network.
        self.flow[edge_id] = lower

    # ------------------------------------------------------------------
    # batched updates (transactional)
    # ------------------------------------------------------------------
    def apply_updates(self, updates: Iterable[dict]) -> None:
        """Apply a batch of updates atomically.

        Validation happens on private copies; if any update is invalid an
        ``UpdateError`` is raised and the model, the current flow, the
        residual caches and the published snapshot are left untouched.
        """
        edges = dict(self.edges)
        demands = dict(self.demands)
        flow = dict(self.flow)
        for update in updates:
            self._apply_one(update, edges, demands, flow)
        self.edges, self.demands, self.flow = edges, demands, flow

    @staticmethod
    def _apply_one(update: dict, edges: dict, demands: dict, flow: dict) -> None:
        if not isinstance(update, dict) or "op" not in update:
            raise UpdateError(f"malformed update {update!r}")
        op = update["op"]

        if op == "set_bounds":
            eid = update.get("edge")
            if eid not in edges:
                raise UpdateError(f"unknown edge {eid!r}")
            lower = _require_int(update.get("lower"), "lower")
            upper = _require_int(update.get("upper"), "upper")
            if lower < 0:
                raise UpdateError(f"lower bound must be >= 0, got {lower}")
            if upper < lower:
                raise UpdateError(f"upper bound {upper} < lower bound {lower}")
            e = edges[eid]
            edges[eid] = Edge(e.id, e.tail, e.head, lower, upper, e.cost)

        elif op == "set_cost":
            eid = update.get("edge")
            if eid not in edges:
                raise UpdateError(f"unknown edge {eid!r}")
            cost = _require_int(update.get("cost"), "cost")
            e = edges[eid]
            edges[eid] = Edge(e.id, e.tail, e.head, e.lower, e.upper, cost)

        elif op == "set_demand":
            node = update.get("node")
            if node not in demands:
                raise UpdateError(f"unknown node {node!r}")
            demands[node] = _require_int(update.get("demand"), "demand")

        elif op == "add_edge":
            eid = update.get("id")
            if eid in edges:
                raise UpdateError(f"duplicate edge id {eid!r}")
            lower = _require_int(update.get("lower", 0), "lower")
            upper = _require_int(update.get("upper", 0), "upper")
            cost = _require_int(update.get("cost", 0), "cost")
            if lower < 0:
                raise UpdateError(f"lower bound must be >= 0, got {lower}")
            if upper < lower:
                raise UpdateError(f"upper bound {upper} < lower bound {lower}")
            tail, head = update.get("tail"), update.get("head")
            if tail is None or head is None:
                raise UpdateError("add_edge requires tail and head")
            demands.setdefault(tail, 0)
            demands.setdefault(head, 0)
            edges[eid] = Edge(eid, tail, head, lower, upper, cost)
            flow[eid] = lower

        elif op == "remove_edge":
            eid = update.get("edge")
            if eid not in edges:
                raise UpdateError(f"unknown edge {eid!r}")
            del edges[eid]
            flow.pop(eid, None)

        else:
            raise UpdateError(f"unknown update op {op!r}")

    # ------------------------------------------------------------------
    # published snapshot
    # ------------------------------------------------------------------
    @property
    def published(self) -> Optional[SolveResult]:
        """The last published feasible result (survives infeasible updates)."""
        return self._published

    # ------------------------------------------------------------------
    # solving
    # ------------------------------------------------------------------
    def solve(self, budget: Optional[int] = None) -> SolveResult:
        """Repair feasibility from the current flow, then optimise cost.

        ``budget`` bounds the number of cost-improving cycle augmentations.
        If the budget runs out first, the result is feasible but
        ``optimal`` is False and no potentials are emitted.
        """
        self._rebuild_adjacency()
        if not self._rebalance():
            certificate = self._build_certificate()
            return SolveResult(feasible=False, optimal=False,
                               certificate=certificate)
        optimal = self._cancel_cycles(budget)
        result = SolveResult(
            feasible=True,
            optimal=optimal,
            flow=dict(self.flow),
            cost=self._total_cost(),
            potentials=self._compute_potentials() if optimal else None,
        )
        self._published = result
        return result

    # ------------------------------------------------------------------
    # feasibility repair
    # ------------------------------------------------------------------
    def _rebuild_adjacency(self) -> None:
        self._out = {v: [] for v in self.demands}
        self._in = {v: [] for v in self.demands}
        for e in self.edges.values():
            self._out[e.tail].append(e.id)
            self._in[e.head].append(e.id)

    def _residual_arcs_from(self, u: Hashable):
        """Residual arcs leaving node ``u``: (head, edge_id, direction, cap)."""
        for eid in self._out[u]:
            e = self.edges[eid]
            f = self.flow[eid]
            if f < e.upper:
                yield (e.head, eid, 1, e.upper - f)
        for eid in self._in[u]:
            e = self.edges[eid]
            f = self.flow[eid]
            if f > e.lower:
                yield (e.tail, eid, -1, f - e.lower)

    def _rebalance(self) -> bool:
        """Restore feasibility by rerouting imbalances along residual arcs."""
        for eid, e in self.edges.items():
            f = self.flow.get(eid, e.lower)
            self.flow[eid] = min(max(f, e.lower), e.upper)

        bal = {v: -d for v, d in self.demands.items()}
        for e in self.edges.values():
            f = self.flow[e.id]
            bal[e.head] += f
            bal[e.tail] -= f

        while True:
            sources = [v for v, b in bal.items() if b > 0]
            if not sources:
                if all(b == 0 for b in bal.values()):
                    return True
                # Total demand is positive: the trivial cut X = V violates
                # demand(X) > upper_in(X) - lower_out(X) = 0.
                self._cert_hint = {"form": "demand",
                                   "nodes": list(self.demands)}
                return False

            # Multi-source BFS towards any deficit node.
            prev = {s: None for s in sources}
            queue = deque(sources)
            target = None
            while queue and target is None:
                u = queue.popleft()
                for (v, eid, direction, cap) in self._residual_arcs_from(u):
                    if v in prev:
                        continue
                    prev[v] = (u, eid, direction, cap)
                    if bal[v] < 0:
                        target = v
                        break
                    queue.append(v)

            if target is None:
                # No deficit reachable from the remaining excess.  The set R
                # of reachable nodes satisfies the supply-side cut condition
                # demand(R) < lower_in(R) - upper_out(R).
                self._cert_hint = {"form": "supply", "nodes": list(prev)}
                return False

            # Bottleneck of the path, also limited by the endpoint imbalance.
            path = []
            node = target
            while prev[node] is not None:
                u, eid, direction, cap = prev[node]
                path.append((eid, direction, cap))
                node = u
            source = node
            delta = min(bal[source], -bal[target],
                        min(cap for _, _, cap in path))
            for eid, direction, _ in path:
                self.flow[eid] += delta if direction == 1 else -delta
            bal[source] -= delta
            bal[target] += delta

    def _build_certificate(self) -> dict:
        hint = self._cert_hint
        nodes = list(hint["nodes"])
        node_set = set(nodes)
        demand = sum(self.demands[v] for v in node_set)
        upper_in = lower_in = upper_out = lower_out = 0
        for e in self.edges.values():
            tail_in = e.tail in node_set
            head_in = e.head in node_set
            if head_in and not tail_in:
                upper_in += e.upper
                lower_in += e.lower
            elif tail_in and not head_in:
                upper_out += e.upper
                lower_out += e.lower
        return {
            "form": hint["form"],
            "nodes": nodes,
            "demand": demand,
            "upper_in": upper_in,
            "lower_in": lower_in,
            "upper_out": upper_out,
            "lower_out": lower_out,
        }

    # ------------------------------------------------------------------
    # cost optimisation (cycle cancelling on the residual network)
    # ------------------------------------------------------------------
    def _all_residual_arcs(self):
        """(tail, head, cost, edge_id, direction, cap) for every residual arc."""
        arcs = []
        for e in self.edges.values():
            f = self.flow[e.id]
            if f < e.upper:
                arcs.append((e.tail, e.head, e.cost, e.id, 1, e.upper - f))
            if f > e.lower:
                arcs.append((e.head, e.tail, -e.cost, e.id, -1, f - e.lower))
        return arcs

    def _find_negative_cycle(self):
        """Bellman-Ford from a virtual source; returns a cycle or None.

        A cycle is a list of (edge_id, direction, tail, head) arcs whose
        total cost is negative.
        """
        arcs = self._all_residual_arcs()
        dist = {v: 0 for v in self.demands}
        parent: dict = {}
        n = len(dist)
        last = None
        for _ in range(n):
            last = None
            for (u, v, c, eid, direction, _cap) in arcs:
                if dist[u] + c < dist[v]:
                    dist[v] = dist[u] + c
                    parent[v] = (u, eid, direction)
                    last = v
            if last is None:
                return None
        # ``last`` was relaxed in the n-th pass: a negative cycle exists.
        v = last
        for _ in range(n):
            v = parent[v][0]
        cycle = []
        cur = v
        while True:
            u, eid, direction = parent[cur]
            cycle.append((eid, direction, u, cur))
            cur = u
            if cur == v:
                break
        return cycle

    def _cancel_cycles(self, budget: Optional[int]) -> bool:
        iterations = 0
        while True:
            cycle = self._find_negative_cycle()
            if cycle is None:
                return True
            if budget is not None and iterations >= budget:
                return False
            delta = min(
                (self.edges[eid].upper - self.flow[eid]) if direction == 1
                else (self.flow[eid] - self.edges[eid].lower)
                for (eid, direction, _u, _v) in cycle
            )
            for eid, direction, _u, _v in cycle:
                self.flow[eid] += delta if direction == 1 else -delta
            iterations += 1

    def _compute_potentials(self) -> dict:
        """Shortest-path distances in the residual network (no neg. cycles)."""
        arcs = self._all_residual_arcs()
        dist = {v: 0 for v in self.demands}
        for _ in range(len(dist)):
            changed = False
            for (u, v, c, _eid, _d, _cap) in arcs:
                if dist[u] + c < dist[v]:
                    dist[v] = dist[u] + c
                    changed = True
            if not changed:
                break
        return dist

    def _total_cost(self) -> int:
        return sum(e.cost * self.flow[e.id] for e in self.edges.values())

    # ------------------------------------------------------------------
    # serialisation helpers (used by the CLI)
    # ------------------------------------------------------------------
    def model_dict(self) -> dict:
        return {
            "demands": {str(k): v for k, v in self.demands.items()},
            "edges": [
                {"id": str(e.id), "tail": str(e.tail), "head": str(e.head),
                 "lower": e.lower, "upper": e.upper, "cost": e.cost}
                for e in self.edges.values()
            ],
        }
