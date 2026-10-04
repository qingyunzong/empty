"""Independent exhaustive enumeration used to cross-check the repairer.

Nothing here is shared with the repairer's search logic: feasibility is
decided by brute-force enumeration of every integer flow inside the edge
bounds, which makes it a trustworthy reference for small networks.
"""

from itertools import product


def enumerate_feasible_flows(network, max_combinations=1_000_000):
    """Yield every integer flow satisfying bounds and node demands."""
    total = 1
    for edge in network.edges:
        total *= edge.upper - edge.lower + 1
    if total > max_combinations:
        raise ValueError(
            f"enumeration of {total} combinations refused (limit {max_combinations})"
        )
    tails = [network.node_index(e.tail) for e in network.edges]
    heads = [network.node_index(e.head) for e in network.edges]
    demands = [network.demand(n) for n in network.nodes]
    ranges = [range(e.lower, e.upper + 1) for e in network.edges]
    for combo in product(*ranges):
        divergence = [0] * len(network.nodes)
        for i, x in enumerate(combo):
            divergence[tails[i]] -= x
            divergence[heads[i]] += x
        if divergence == demands:
            yield {edge.id: x for edge, x in zip(network.edges, combo)}


def flow_cost(network, flows):
    return sum(flows[e.id] * e.cost for e in network.edges)


def optimal_cost(network, **kwargs):
    """``(cost, flows)`` of a min-cost feasible flow, or ``None``."""
    best = None
    for flows in enumerate_feasible_flows(network, **kwargs):
        cost = flow_cost(network, flows)
        if best is None or cost < best[0]:
            best = (cost, flows)
    return best


def repair_reference(network, base_flows, **kwargs):
    """Brute-force lexicographic (modifications, L1, cost) optimum.

    Returns ``((modifications, l1, cost), flows)`` or ``None`` when the
    network admits no feasible flow at all.
    """
    best = None
    for flows in enumerate_feasible_flows(network, **kwargs):
        modifications = sum(
            1 for e in network.edges if flows[e.id] != base_flows[e.id]
        )
        l1 = sum(abs(flows[e.id] - base_flows[e.id]) for e in network.edges)
        triple = (modifications, l1, flow_cost(network, flows))
        if best is None or triple < best[0]:
            best = (triple, flows)
    return best
