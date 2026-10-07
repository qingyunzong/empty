"""Independent verifier for solver results.

These functions take only plain data (node list, edge dicts, demand dict,
flow/potential dicts) and re-check every condition from scratch; they share
no state with the solver and can be used to audit (or try to tamper with)
any published result.
"""

from __future__ import annotations

from .model import normalize_edges


def _norm(nodes, edges, demands):
    nodes = [str(n) for n in nodes]
    edges = normalize_edges(edges)
    demands = {str(k): int(v) for k, v in (demands or {}).items()}
    return nodes, edges, demands


def verify_flow(nodes, edges, demands, flows) -> bool:
    """Check bounds lo <= f <= hi and balance inflow-outflow == demand."""
    nodes, edges, demands = _norm(nodes, edges, demands)
    if not isinstance(flows, dict):
        return False
    edge_ids = {e.id for e in edges}
    if set(flows) != edge_ids:
        return False
    balance = {v: -demands.get(v, 0) for v in nodes}
    for e in edges:
        f = flows[e.id]
        if isinstance(f, bool) or not isinstance(f, int):
            return False
        if not (e.lo <= f <= e.hi):
            return False
        balance[e.tail] -= f
        balance[e.head] += f
    return all(x == 0 for x in balance.values())


def verify_optimality(nodes, edges, demands, flows, potentials) -> bool:
    """Check feasibility plus non-negative reduced costs on every residual
    arc: for edge u->v with cost c and potentials pi,
      f < hi  implies  c + pi(u) - pi(v) >= 0   (forward residual arc)
      f > lo  implies  c + pi(u) - pi(v) <= 0   (backward residual arc)
    """
    if not verify_flow(nodes, edges, demands, flows):
        return False
    nodes, edges, _ = _norm(nodes, edges, demands)
    if not isinstance(potentials, dict) or set(potentials) != set(nodes):
        return False
    for v in nodes:
        p = potentials[v]
        if isinstance(p, bool) or not isinstance(p, int):
            return False
    for e in edges:
        f = flows[e.id]
        reduced = e.cost + potentials[e.tail] - potentials[e.head]
        if f < e.hi and reduced < 0:
            return False
        if f > e.lo and reduced > 0:
            return False
    return True


def verify_cut(nodes, edges, demands, certificate) -> bool:
    """Check a cut certificate of infeasibility: the node set X must satisfy

        d(X) > u(delta^-(X)) - l(delta^+(X))

    i.e. the demand inside X exceeds the maximum possible net inflow, so no
    feasible flow can exist. This is a Hoffman/Gale circulation inequality.
    """
    nodes, edges, demands = _norm(nodes, edges, demands)
    if not isinstance(certificate, (list, tuple, set)) or len(certificate) == 0:
        return False
    s = set(certificate)
    if not s or not s.issubset(set(nodes)):
        return False
    demand = sum(demands.get(v, 0) for v in s)
    cap_in = sum(e.hi for e in edges if e.head in s and e.tail not in s)
    lo_out = sum(e.lo for e in edges if e.tail in s and e.head not in s)
    return demand > cap_in - lo_out
