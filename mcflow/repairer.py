"""Budgeted repairer for invalid min-cost flow certificates.

Given a network and a (possibly invalid) submitted flow, find a feasible
flow minimising, in lexicographic order:

1. the number of edges whose flow is modified,
2. the L1 distance to the submitted flow,
3. the total cost of the repaired flow.

The search enumerates candidate change-sets level by level (k = 0, 1, 2,
... modified edges); each candidate is solved exactly as a min-cost flow
whose arc costs encode objectives 2 and 3.  A budget bounds the number of
solver attempts; checkpoints are emitted after every attempt.  When the
budget is exhausted the result contains the best feasible repair found so
far plus proven lower bounds - it is never claimed to be optimal.

If the network itself is infeasible, a cut certificate (a node set T with
demand(T) > capacity into T - lower bounds out of T) is returned, which
can be checked independently with verifier.verify_cut_certificate.
"""

from __future__ import annotations

from dataclasses import dataclass
from itertools import combinations

from .flowsolver import max_flow, min_cost_flow
from .network import _is_int


@dataclass
class RepairResult:
    status: str                 # optimal | feasible | budget_exhausted | infeasible
    flow: dict | None
    changed_edges: int | None
    l1_distance: int | None
    cost: int | None
    lower_bound_changes: int
    l1_lower_bound: int | None
    cost_lower_bound: int | None
    cut: dict | None
    solver_calls: int
    checkpoints: int

    @property
    def optimal(self) -> bool:
        return self.status == "optimal"

    def to_dict(self) -> dict:
        return {
            "status": self.status,
            "optimal": self.optimal,
            "flow": self.flow,
            "changed_edges": self.changed_edges,
            "l1_distance": self.l1_distance,
            "cost": self.cost,
            "lower_bound_changes": self.lower_bound_changes,
            "l1_lower_bound": self.l1_lower_bound,
            "cost_lower_bound": self.cost_lower_bound,
            "cut": self.cut,
            "solver_calls": self.solver_calls,
            "checkpoints": self.checkpoints,
        }


def _sanitize_base_flow(network, flow):
    """Split the submitted flow into per-edge data.

    Returns (anchor, reference, forced_ids):
    - anchor: a value inside [lower, upper] used to build residual arcs;
    - reference: the submitted integer value used to measure L1/changes
      (None when the submitted value was not an integer - such an edge
      always counts as modified);
    - forced_ids: edges every repair is forced to modify.
    """
    anchor, reference, forced = {}, {}, []
    for edge in network.edges:
        value = flow.get(edge.id, 0) if isinstance(flow, dict) else 0
        if not _is_int(value):
            anchor[edge.id] = edge.lower
            reference[edge.id] = None
            forced.append(edge.id)
            continue
        reference[edge.id] = value
        anchor[edge.id] = min(max(value, edge.lower), edge.upper)
        if value < edge.lower or value > edge.upper:
            forced.append(edge.id)
    return anchor, reference, forced


def _infeasibility_cut(network):
    """Max-flow based Hoffman cut: T with demand(T) > u(in T) - l(out of T)."""
    nodes = network.nodes
    index = {v: i for i, v in enumerate(nodes)}
    n = len(nodes)
    source, sink = n, n + 1
    arcs = []
    need = 0
    adjusted = {v: network.demands[v] for v in nodes}
    for edge in network.edges:
        adjusted[edge.tail] += edge.lower
        adjusted[edge.head] -= edge.lower
        arcs.append((index[edge.tail], index[edge.head], edge.upper - edge.lower))
    for v in nodes:
        d = adjusted[v]
        if d > 0:
            arcs.append((index[v], sink, d))
            need += d
        elif d < 0:
            arcs.append((source, index[v], -d))
    value, reachable = max_flow(n + 2, arcs, source, sink)
    if value >= need:
        return None
    members = [v for v in nodes if not reachable[index[v]]]
    member_set = set(members)
    demand = sum(network.demands[v] for v in members)
    capacity_in = sum(e.upper for e in network.edges
                      if e.head in member_set and e.tail not in member_set)
    lower_out = sum(e.lower for e in network.edges
                    if e.tail in member_set and e.head not in member_set)
    cut = {"nodes": members, "demand": demand,
           "capacity_in": capacity_in, "lower_out": lower_out}
    assert demand > capacity_in - lower_out, "max-flow min-cut inconsistency"
    return cut


def _attempt(network, anchor, reference, changeable):
    """Best repair (L1 then cost) that may only modify edges in `changeable`.

    Arc costs encode the lexicographic (L1, cost) objective: each unit of
    deviation from the anchor costs `weight`, each unit of flow costs its
    edge cost, with `weight` large enough to dominate any cost difference.
    """
    weight = 1 + sum(abs(e.cost) * (e.upper - e.lower) for e in network.edges)
    balances = {v: network.demands[v] for v in network.nodes}
    arcs = []
    for edge in network.edges:
        a = anchor[edge.id]
        balances[edge.tail] += a
        balances[edge.head] -= a
        if edge.id in changeable:
            if a < edge.upper:
                arcs.append((edge.tail, edge.head, edge.upper - a,
                             weight + edge.cost, (edge.id, 1)))
            if a > edge.lower:
                arcs.append((edge.head, edge.tail, a - edge.lower,
                             weight - edge.cost, (edge.id, -1)))
    flows = min_cost_flow(network.nodes, arcs, balances)
    if flows is None:
        return None
    repaired = {}
    for edge in network.edges:
        repaired[edge.id] = (anchor[edge.id]
                             + flows.get((edge.id, 1), 0)
                             - flows.get((edge.id, -1), 0))
    l1 = 0
    changed = 0
    for edge in network.edges:
        ref = reference[edge.id]
        if ref is None:
            changed += 1
            l1 += abs(repaired[edge.id] - anchor[edge.id])
        else:
            l1 += abs(repaired[edge.id] - ref)
            if repaired[edge.id] != ref:
                changed += 1
    cost = sum(e.cost * repaired[e.id] for e in network.edges)
    return {"flow": repaired, "l1": l1, "cost": cost, "changed": changed}


def repair(network, flow, budget=None, checkpoint=None) -> RepairResult:
    anchor, reference, forced = _sanitize_base_flow(network, flow)
    forced_set = set(forced)
    others = [e.id for e in network.edges if e.id not in forced_set]

    # Network-level feasibility (not charged against the repair budget).
    cut = _infeasibility_cut(network)
    if cut is not None:
        return RepairResult(status="infeasible", flow=None, changed_edges=None,
                            l1_distance=None, cost=None,
                            lower_bound_changes=len(forced),
                            l1_lower_bound=None, cost_lower_bound=None,
                            cut=cut, solver_calls=0, checkpoints=0)

    # Proven bounds independent of the search.
    l1_lower_bound = 0
    for edge in network.edges:
        if edge.id in forced_set:
            ref = reference[edge.id]
            if ref is not None:
                l1_lower_bound += max(edge.lower - ref, 0) + max(ref - edge.upper, 0)
    cost_flow = min_cost_flow(
        network.nodes,
        [(e.tail, e.head, e.upper - e.lower, e.cost, e.id) for e in network.edges],
        {v: network.demands[v] - sum(e.lower for e in network.edges if e.head == v)
         + sum(e.lower for e in network.edges if e.tail == v)
         for v in network.nodes})
    cost_lower_bound = None
    if cost_flow is not None:
        cost_lower_bound = sum(e.cost * (cost_flow.get(e.id, 0) + e.lower)
                               for e in network.edges)

    best = None
    calls = 0
    checkpoints = 0
    highest_infeasible_level = len(forced) - 1
    status = None
    level = len(forced)
    while level <= len(network.edges):
        extra = level - len(forced)
        completed_level = True
        for subset in combinations(others, extra):
            if budget is not None and calls >= budget:
                completed_level = False
                break
            calls += 1
            changeable = forced_set | set(subset)
            candidate = _attempt(network, anchor, reference, changeable)
            if candidate is not None and (
                    best is None
                    or (candidate["l1"], candidate["cost"]) < (best["l1"], best["cost"])):
                best = candidate
            checkpoints += 1
            if checkpoint is not None:
                checkpoint({
                    "event": "attempt",
                    "level": level,
                    "subset": sorted(changeable),
                    "feasible": candidate is not None,
                    "solver_calls": calls,
                    "budget": budget,
                    "best": None if best is None else {
                        "changed_edges": best["changed"],
                        "l1_distance": best["l1"],
                        "cost": best["cost"],
                    },
                })
        if best is not None:
            status = "optimal" if completed_level else "feasible"
            break
        if not completed_level:
            status = "budget_exhausted"
            break
        highest_infeasible_level = level
        level += 1

    lower_bound_changes = max(len(forced), highest_infeasible_level + 1)
    return RepairResult(
        status=status,
        flow=None if best is None else best["flow"],
        changed_edges=None if best is None else best["changed"],
        l1_distance=None if best is None else best["l1"],
        cost=None if best is None else best["cost"],
        lower_bound_changes=lower_bound_changes,
        l1_lower_bound=l1_lower_bound,
        cost_lower_bound=cost_lower_bound,
        cut=None,
        solver_calls=calls,
        checkpoints=checkpoints,
    )
