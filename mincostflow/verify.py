"""Independent verifier for flows, optimality potentials and cut certificates.

These functions deliberately operate on plain dictionaries (not on solver
objects) so a result can be checked without trusting the solver at all.
Every function returns a list of human-readable problems; an empty list
means the check passed.
"""

from __future__ import annotations


def check_flow(demands: dict, edges: list, flow: dict) -> list:
    """Verify edge bounds and node balance constraints."""
    problems = []
    if not isinstance(flow, dict):
        return ["flow is not a mapping"]
    edge_ids = set()
    for e in edges:
        eid = e["id"]
        edge_ids.add(eid)
        if eid not in flow:
            problems.append(f"edge {eid!r} has no flow value")
            continue
        f = flow[eid]
        if isinstance(f, bool) or not isinstance(f, int):
            problems.append(f"edge {eid!r} flow {f!r} is not an integer")
            continue
        if f < e["lower"]:
            problems.append(
                f"edge {eid!r} flow {f} below lower bound {e['lower']}")
        if f > e["upper"]:
            problems.append(
                f"edge {eid!r} flow {f} above upper bound {e['upper']}")
    for eid in flow:
        if eid not in edge_ids:
            problems.append(f"flow given for unknown edge {eid!r}")

    bal = {v: -d for v, d in demands.items()}
    for e in edges:
        eid = e["id"]
        f = flow.get(eid)
        if not isinstance(f, int) or isinstance(f, bool):
            continue
        for node in (e["tail"], e["head"]):
            if node not in bal:
                problems.append(f"edge {eid!r} touches unknown node {node!r}")
                bal[node] = 0
        bal[e["head"]] += f
        bal[e["tail"]] -= f
    for v, b in bal.items():
        if b != 0:
            problems.append(
                f"node {v!r} balance violated: inflow-outflow-demand = {b}")
    return problems


def check_optimality(demands: dict, edges: list, flow: dict,
                     potentials: dict) -> list:
    """Verify feasibility plus non-negative reduced costs on residual arcs.

    For every edge e = (u, v) with reduced cost rc = cost + p[u] - p[v]:
    flow < upper requires rc >= 0 (forward residual arc), and
    flow > lower requires rc <= 0 (backward residual arc).
    """
    problems = check_flow(demands, edges, flow)
    if not isinstance(potentials, dict):
        problems.append("potentials are not a mapping")
        return problems
    for v in demands:
        if v not in potentials:
            problems.append(f"node {v!r} has no potential")
        elif isinstance(potentials[v], bool) or not isinstance(potentials[v], int):
            problems.append(f"potential of node {v!r} is not an integer")
    if problems:
        return problems
    for e in edges:
        eid = e["id"]
        f = flow[eid]
        rc = e["cost"] + potentials[e["tail"]] - potentials[e["head"]]
        if f < e["upper"] and rc < 0:
            problems.append(
                f"edge {eid!r} has residual capacity but reduced cost {rc} < 0")
        if f > e["lower"] and rc > 0:
            problems.append(
                f"edge {eid!r} has backward residual capacity but reduced "
                f"cost {rc} > 0")
    return problems


def check_cut_certificate(demands: dict, edges: list, certificate: dict) -> list:
    """Verify a Hoffman-style cut certificate of infeasibility.

    The certificate names a node set X and a form:

    * ``demand``: demand(X) > upper_in(X) - lower_out(X)
    * ``supply``: demand(X) < lower_in(X) - upper_out(X)

    All sums are recomputed from the model; the claimed sums inside the
    certificate are informational only.
    """
    problems = []
    if not isinstance(certificate, dict):
        return ["certificate is not a mapping"]
    form = certificate.get("form")
    nodes = certificate.get("nodes")
    if form not in ("demand", "supply"):
        problems.append(f"unknown certificate form {form!r}")
    if not isinstance(nodes, list) or not nodes:
        problems.append("certificate must name a non-empty node set")
        return problems
    node_set = set()
    for v in nodes:
        if v not in demands:
            problems.append(f"certificate names unknown node {v!r}")
        node_set.add(v)
    if problems:
        return problems

    demand = sum(demands[v] for v in node_set)
    upper_in = lower_in = upper_out = lower_out = 0
    for e in edges:
        tail_in = e["tail"] in node_set
        head_in = e["head"] in node_set
        if head_in and not tail_in:
            upper_in += e["upper"]
            lower_in += e["lower"]
        elif tail_in and not head_in:
            upper_out += e["upper"]
            lower_out += e["lower"]

    if form == "demand":
        if not demand > upper_in - lower_out:
            problems.append(
                f"demand form not violated: demand(X)={demand} <= "
                f"upper_in-lower_out={upper_in - lower_out}")
    elif form == "supply":
        if not demand < lower_in - upper_out:
            problems.append(
                f"supply form not violated: demand(X)={demand} >= "
                f"lower_in-upper_out={lower_in - upper_out}")
    return problems
