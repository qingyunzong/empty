"""Independent certificate verifier.

This module deliberately does NOT import the repairer: every check is a
direct, self-contained verification of the submitted certificate against
the network.  Checks performed, each producing concrete violations:

1. capacity   - every edge flow is an integer within [lower, upper]
2. balance    - flow conservation: inflow - outflow == demand at every node
3. cost       - sum(cost_e * flow_e) equals the declared total cost
4. optimality - reduced costs on every residual edge w.r.t. the submitted
                node potentials, plus an explicit negative-cost residual
                cycle (actual costs) when the flow is not optimal
"""

from __future__ import annotations

from dataclasses import dataclass, field

from .flowsolver import _add_arc, find_negative_cycle
from .network import _is_int


@dataclass
class VerificationReport:
    ok: bool
    violations: list = field(default_factory=list)

    def to_dict(self) -> dict:
        return {"ok": self.ok, "violations": self.violations}


def _residual_negative_cycle(network, flows):
    index = {v: i for i, v in enumerate(network.nodes)}
    graph = [[] for _ in range(len(network.nodes))]
    arc_labels = {}
    for edge in network.edges:
        f = flows[edge.id]
        if f < edge.upper:
            arc = _add_arc(graph, index[edge.tail], index[edge.head],
                           edge.upper - f, edge.cost)
            arc_labels[id(arc)] = (edge.id, "forward")
        if f > edge.lower:
            arc = _add_arc(graph, index[edge.head], index[edge.tail],
                           f - edge.lower, -edge.cost)
            arc_labels[id(arc)] = (edge.id, "backward")
    cycle = find_negative_cycle(graph)
    if cycle is None:
        return None
    return {
        "arcs": [{"edge": arc_labels[id(arc)][0],
                  "direction": arc_labels[id(arc)][1]} for arc in cycle],
        "total_cost": sum(arc.cost for arc in cycle),
    }


def verify(network, certificate) -> VerificationReport:
    violations = []
    if not isinstance(certificate, dict):
        return VerificationReport(ok=False, violations=[
            {"type": "invalid_certificate", "detail": "certificate must be an object"}])

    raw_flows = certificate.get("flows")
    if not isinstance(raw_flows, dict):
        violations.append({"type": "missing_flows"})
        raw_flows = {}
    potentials = certificate.get("potentials")
    if not isinstance(potentials, dict):
        potentials = {}
        violations.append({"type": "missing_potentials"})
    declared_cost = certificate.get("declared_cost")

    # --- 1. capacity / integrality -------------------------------------
    flows = {}
    edge_ids = {e.id for e in network.edges}
    for edge_id in raw_flows:
        if edge_id not in edge_ids:
            violations.append({"type": "unknown_edge", "edge": edge_id})
    flows_complete = True
    for edge in network.edges:
        if edge.id not in raw_flows:
            violations.append({"type": "missing_flow", "edge": edge.id})
            flows[edge.id] = 0
            flows_complete = False
            continue
        value = raw_flows[edge.id]
        if not _is_int(value):
            violations.append({"type": "non_integer_flow", "edge": edge.id,
                               "value": value})
            flows[edge.id] = 0
            flows_complete = False
            continue
        flows[edge.id] = value
        if value < edge.lower or value > edge.upper:
            violations.append({"type": "capacity", "edge": edge.id, "flow": value,
                               "lower": edge.lower, "upper": edge.upper})

    # --- 2. conservation / demands --------------------------------------
    balance = {v: 0 for v in network.nodes}
    for edge in network.edges:
        balance[edge.tail] -= flows[edge.id]
        balance[edge.head] += flows[edge.id]
    for node in network.nodes:
        demand = network.demands[node]
        if balance[node] != demand:
            violations.append({"type": "conservation", "node": node,
                               "demand": demand, "actual": balance[node]})

    # --- 3. declared cost ------------------------------------------------
    actual_cost = sum(e.cost * flows[e.id] for e in network.edges)
    if not _is_int(declared_cost):
        violations.append({"type": "missing_declared_cost",
                           "declared": declared_cost})
    elif declared_cost != actual_cost:
        violations.append({"type": "cost_mismatch", "declared": declared_cost,
                           "actual": actual_cost})

    # --- 4. reduced costs + negative residual cycle ----------------------
    if flows_complete:
        missing_pi = [v for v in network.nodes if v not in potentials]
        for node in missing_pi:
            violations.append({"type": "missing_potential", "node": node})
        if not missing_pi:
            for edge in network.edges:
                rc = edge.cost + potentials[edge.tail] - potentials[edge.head]
                f = flows[edge.id]
                if f < edge.upper and rc < 0:
                    violations.append({"type": "reduced_cost", "edge": edge.id,
                                       "direction": "forward",
                                       "reduced_cost": rc})
                if f > edge.lower and rc > 0:
                    violations.append({"type": "reduced_cost", "edge": edge.id,
                                       "direction": "backward",
                                       "reduced_cost": -rc})
        cycle = _residual_negative_cycle(network, flows)
        if cycle is not None:
            violations.append({"type": "negative_cycle", **cycle})

    return VerificationReport(ok=not violations, violations=violations)


def verify_cut_certificate(network, cut) -> bool:
    """Independently verify an infeasibility cut certificate.

    The cut claims that the node set T cannot satisfy its net demand:
    demand(T) > capacity into T minus lower bounds out of T.
    """
    if not isinstance(cut, dict) or not isinstance(cut.get("nodes"), list):
        return False
    members = set(cut["nodes"])
    if not members or not members.issubset(set(network.nodes)):
        return False
    demand = sum(network.demands[v] for v in members)
    capacity_in = sum(e.upper for e in network.edges
                      if e.head in members and e.tail not in members)
    lower_out = sum(e.lower for e in network.edges
                    if e.tail in members and e.head not in members)
    if cut.get("demand") != demand:
        return False
    if cut.get("capacity_in") != capacity_in:
        return False
    if cut.get("lower_out") != lower_out:
        return False
    return demand > capacity_in - lower_out
