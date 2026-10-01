"""Regin's filtering algorithm for allDifferent.

Removes every (variable, value) edge that does not belong to any maximum
matching of the value graph, using one maximum matching plus alternating
path / strongly-connected-component decomposition.  This is strictly
stronger than only looking at assigned variables: it also detects Hall
sets among unassigned variables.
"""

from collections import defaultdict

from .errors import Conflict


def _sort_key(node):
    # Variables are strings, values are ints; keep iteration deterministic.
    return (0, node) if isinstance(node, int) else (1, node)


def _kosaraju_scc(adj, radj, nodes):
    """Return dict node -> scc id using Kosaraju's algorithm (iterative)."""
    visited = set()
    order = []
    for root in sorted(nodes, key=_sort_key):
        if root in visited:
            continue
        visited.add(root)
        stack = [(root, iter(sorted(adj[root], key=_sort_key)))]
        while stack:
            node, it = stack[-1]
            advanced = False
            for nxt in it:
                if nxt not in visited:
                    visited.add(nxt)
                    stack.append((nxt, iter(sorted(adj[nxt], key=_sort_key))))
                    advanced = True
                    break
            if not advanced:
                order.append(node)
                stack.pop()
    scc_id = {}
    cid = 0
    for root in reversed(order):
        if root in scc_id:
            continue
        scc_id[root] = cid
        stack = [root]
        while stack:
            node = stack.pop()
            for nxt in radj[node]:
                if nxt not in scc_id:
                    scc_id[nxt] = cid
                    stack.append(nxt)
        cid += 1
    return scc_id


def alldiff_removals(variables, domains):
    """Compute (removals, matching) for allDifferent over ``variables``.

    ``domains`` maps variable name -> current set of ints.
    Raises Conflict if no matching covers all variables (Hall violation).
    """
    match_var = {}
    match_val = {}

    def augment(var, seen):
        for val in sorted(domains[var]):
            if val in seen:
                continue
            seen.add(val)
            if val not in match_val or augment(match_val[val], seen):
                match_var[var] = val
                match_val[val] = var
                return True
        return False

    for var in variables:
        if var not in match_var and not augment(var, set()):
            raise Conflict(variable=var)

    # Oriented graph: unmatched edges var -> value, matched edges value -> var.
    adj = defaultdict(set)
    radj = defaultdict(set)
    all_values = set()
    for var in variables:
        for val in domains[var]:
            all_values.add(val)
            if match_var[var] == val:
                adj[val].add(var)
                radj[var].add(val)
            else:
                adj[var].add(val)
                radj[val].add(var)

    free_values = [v for v in all_values if v not in match_val]

    # Nodes that can reach a free value: an unmatched edge (x, y) lies on an
    # even alternating path starting at a free vertex iff y reaches one.
    reaches_free = set(free_values)
    stack = list(free_values)
    while stack:
        node = stack.pop()
        for prev in radj[node]:
            if prev not in reaches_free:
                reaches_free.add(prev)
                stack.append(prev)

    scc_id = _kosaraju_scc(adj, radj, set(variables) | all_values)

    removals = []
    for var in variables:
        for val in sorted(domains[var]):
            if match_var[var] == val:
                continue  # matched edges always belong to a maximum matching
            if scc_id[var] == scc_id[val]:
                continue  # edge on an alternating cycle
            if val in reaches_free:
                continue  # edge on an even alternating path from a free value
            removals.append((var, val))
    return removals, dict(match_var)


class AllDifferentConstraint:
    type = "allDifferent"

    def __init__(self, cid, variables):
        self.id = cid
        self.variables = list(variables)
        self.matching = {}

    def revise(self, domains):
        removals, matching = alldiff_removals(self.variables, domains)
        self.matching = matching
        return removals

    def to_spec(self):
        return {"type": "allDifferent", "id": self.id,
                "vars": list(self.variables)}
