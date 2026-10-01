"""Dedicated propagation for the AllDifferent global constraint.

The propagator is Regin's matching-based filtering algorithm:

1. Build the variable-value bipartite graph and compute a maximum matching.
   If the matching size is smaller than the number of variables, the
   constraint is unsatisfiable (Hall condition violated).
2. Orient matched edges value -> variable and unmatched edges
   variable -> value.  In this directed graph, detect Hall sets
   implicitly: a Hall set of k variables spans exactly k values, which
   corresponds to strongly connected components (SCCs) and to vertices
   that cannot reach a free (unmatched) value.
3. Keep an edge (x, v) iff it belongs to some maximum matching, i.e.:
   - it is a matched edge, or
   - x and v lie in the same SCC, or
   - v can reach a free value through an alternating path.
   All other values are removed from the variable domains.

The resulting pruning is exactly the pruning obtained by running AC-3
on the decomposition of AllDifferent into pairwise not-equal constraints
(i.e. generalized arc consistency for alldiff).
"""

from __future__ import annotations


class DomainError(ValueError):
    """Raised when the input domains are malformed."""


def validate_domains(data):
    """Validate and normalize a JSON-decoded domain list.

    Returns a list of sorted unique integer lists.  Raises DomainError
    for non-list input, non-list domains, or non-integer values
    (booleans are rejected even though bool is a subclass of int).
    """
    if not isinstance(data, list):
        raise DomainError("input must be a JSON list of integer domain lists")
    domains = []
    for i, domain in enumerate(data):
        if not isinstance(domain, list):
            raise DomainError(f"domain of variable {i} must be a list")
        values = []
        for value in domain:
            if isinstance(value, bool) or not isinstance(value, int):
                raise DomainError(
                    f"domain of variable {i} contains a non-integer value: {value!r}"
                )
            values.append(value)
        domains.append(sorted(set(values)))
    return domains


def _max_matching(domains, value_index):
    """Kuhn's augmenting-path algorithm on the variable-value graph.

    Returns (match_var, match_val, size) where match_var[x] is the value
    index matched to variable x (or -1) and match_val[w] is the variable
    matched to value index w (or -1).
    """
    num_vars = len(domains)
    num_values = len(value_index)
    adjacency = [[value_index[v] for v in domain] for domain in domains]
    match_val = [-1] * num_values

    def augment(var, seen):
        for val in adjacency[var]:
            if seen[val]:
                continue
            seen[val] = True
            if match_val[val] == -1 or augment(match_val[val], seen):
                match_val[val] = var
                return True
        return False

    size = 0
    for var in range(num_vars):
        if augment(var, [False] * num_values):
            size += 1
    match_var = [-1] * num_vars
    for val, var in enumerate(match_val):
        if var != -1:
            match_var[var] = val
    return match_var, match_val, size


def _tarjan_scc(adjacency):
    """Iterative Tarjan SCC. Returns a list mapping node -> component id."""
    num_nodes = len(adjacency)
    index_of = [-1] * num_nodes
    lowlink = [0] * num_nodes
    on_stack = [False] * num_nodes
    stack = []
    component = [-1] * num_nodes
    next_index = 0
    num_components = 0

    for root in range(num_nodes):
        if index_of[root] != -1:
            continue
        work = [(root, 0)]
        while work:
            node, child_pos = work[-1]
            if child_pos == 0:
                index_of[node] = lowlink[node] = next_index
                next_index += 1
                stack.append(node)
                on_stack[node] = True
            descended = False
            pos = child_pos
            neighbors = adjacency[node]
            while pos < len(neighbors):
                nxt = neighbors[pos]
                if index_of[nxt] == -1:
                    work[-1] = (node, pos + 1)
                    work.append((nxt, 0))
                    descended = True
                    break
                if on_stack[nxt]:
                    lowlink[node] = min(lowlink[node], index_of[nxt])
                pos += 1
            if descended:
                continue
            if lowlink[node] == index_of[node]:
                while True:
                    member = stack.pop()
                    on_stack[member] = False
                    component[member] = num_components
                    if member == node:
                        break
                num_components += 1
            work.pop()
            if work:
                parent = work[-1][0]
                lowlink[parent] = min(lowlink[parent], lowlink[node])
    return component


def propagate(domains):
    """Filter domains with the AllDifferent propagator.

    Args:
        domains: list of lists of ints (already validated/normalized).

    Returns:
        (status, new_domains) where status is "complete" or "unsat".
        new_domains is None when status is "unsat".
    """
    num_vars = len(domains)
    if num_vars == 0:
        return "complete", []

    values = sorted({v for domain in domains for v in domain})
    num_values = len(values)
    value_index = {v: i for i, v in enumerate(values)}

    match_var, match_val, matching_size = _max_matching(domains, value_index)
    if matching_size < num_vars:
        return "unsat", None

    # Directed graph: nodes 0..n-1 are variables, n..n+m-1 are values.
    # Matched edges point value -> variable, unmatched variable -> value.
    total = num_vars + num_values
    adjacency = [[] for _ in range(total)]
    reverse = [[] for _ in range(total)]
    for var in range(num_vars):
        for value in domains[var]:
            val_node = num_vars + value_index[value]
            if match_var[var] == value_index[value]:
                src, dst = val_node, var
            else:
                src, dst = var, val_node
            adjacency[src].append(dst)
            reverse[dst].append(src)

    # Nodes that can reach a free (unmatched) value via a directed path.
    reaches_free = [False] * total
    stack = []
    for val in range(num_values):
        if match_val[val] == -1:
            node = num_vars + val
            reaches_free[node] = True
            stack.append(node)
    while stack:
        node = stack.pop()
        for pred in reverse[node]:
            if not reaches_free[pred]:
                reaches_free[pred] = True
                stack.append(pred)

    component = _tarjan_scc(adjacency)

    new_domains = []
    for var in range(num_vars):
        kept = []
        for value in domains[var]:
            val_idx = value_index[value]
            val_node = num_vars + val_idx
            if (
                match_var[var] == val_idx
                or component[var] == component[val_node]
                or reaches_free[val_node]
            ):
                kept.append(value)
        if not kept:
            return "unsat", None
        new_domains.append(kept)
    return "complete", new_domains
