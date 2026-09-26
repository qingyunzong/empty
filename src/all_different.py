"""allDifferent global constraint: feasibility, Hall conflicts, support filtering.

Feasibility of an ``allDifferent(x1, ..., xn)`` over finite domains is
exactly the question whether the bipartite graph
``variables -- (value in domain) -- values`` admits a matching covering
every variable (Hall's marriage theorem).  Everything here is built on a
plain augmenting-path maximum matching; no SAT/SMT solver is used.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Hashable, Mapping


@dataclass(frozen=True)
class HallConflict:
    """A violated Hall condition.

    ``variables`` is a set of variables whose combined domain ``values``
    contains fewer distinct values than variables, so no assignment can
    satisfy allDifferent on them.
    """

    variables: frozenset
    values: frozenset

    def __repr__(self) -> str:
        vs = ", ".join(sorted(map(repr, self.variables)))
        ws = ", ".join(sorted(map(repr, self.values)))
        return f"HallConflict(variables={{{vs}}}, values={{{ws}}})"


@dataclass(frozen=True)
class FeasibilityResult:
    feasible: bool
    """A variable->value matching covering every variable, or None."""
    witness: dict | None
    """A violated Hall set when infeasible, otherwise None."""
    hall_conflict: HallConflict | None


def _value_index(domains: Mapping):
    """Distinct values across all domains, repr-sorted, with index map."""
    present = set()
    for domain in domains.values():
        present.update(domain)
    values = sorted(present, key=repr)
    return values, {value: index for index, value in enumerate(values)}


def _adjacency(domains: Mapping, value_index: Mapping):
    """Per-variable list of value indices (insertion order of domains)."""
    return {
        name: [value_index[value] for value in domain]
        for name, domain in domains.items()
    }


def _maximum_matching(adjacency: Mapping, n: int, m: int):
    """Kuhn's augmenting-path algorithm (iterative DFS).

    Returns ``(match_x, match_v, size)`` with unmatched entries equal -1.
    """
    match_x = [-1] * n
    match_v = [-1] * m
    variables = list(adjacency)

    def augment(start: int) -> bool:
        seen = {start}
        parent_var = {}
        stack = [(start, 0)]
        while stack:
            var, edge_pos = stack[-1]
            neighbors = adjacency[variables[var]]
            if edge_pos < len(neighbors):
                value = neighbors[edge_pos]
                stack[-1] = (var, edge_pos + 1)
                owner = match_v[value]
                if owner == -1:
                    cur_var, cur_val = var, value
                    while True:
                        prev_val = match_x[cur_var]
                        match_x[cur_var] = cur_val
                        match_v[cur_val] = cur_var
                        if cur_var not in parent_var:
                            break
                        cur_var, cur_val = parent_var[cur_var], prev_val
                    return True
                if owner not in seen:
                    seen.add(owner)
                    parent_var[owner] = var
                    stack.append((owner, 0))
            else:
                stack.pop()
        return False

    size = 0
    for index in range(n):
        if augment(index):
            size += 1
    return match_x, match_v, size


def _hall_conflict(
    adjacency: Mapping, variables: list, values: list,
    match_x: list, match_v: list,
) -> HallConflict:
    """Canonical violated Hall set via alternating reachability.

    BFS from every unmatched variable, alternating free edges
    (variable -> value) with matched edges (value -> owner variable).
    The reached variables have a strictly smaller reached neighborhood.
    """
    reached_vars: set = set()
    reached_vals: set = set()
    queue = [i for i, matched in enumerate(match_x) if matched == -1]
    reached_vars.update(queue)
    head = 0
    while head < len(queue):
        var = queue[head]
        head += 1
        for value in adjacency[variables[var]]:
            if value not in reached_vals:
                reached_vals.add(value)
                owner = match_v[value]
                if owner != -1 and owner not in reached_vars:
                    reached_vars.add(owner)
                    queue.append(owner)
    return HallConflict(
        variables=frozenset(variables[i] for i in reached_vars),
        values=frozenset(values[j] for j in reached_vals),
    )


def check_feasible(domains: Mapping) -> FeasibilityResult:
    """Check allDifferent feasibility by bipartite maximum matching."""
    variables = list(domains)
    values, value_index = _value_index(domains)
    adjacency = _adjacency(domains, value_index)
    match_x, match_v, size = _maximum_matching(
        adjacency, len(variables), len(values)
    )
    if size == len(variables):
        witness = {
            name: values[match_x[index]]
            for index, name in enumerate(variables)
        }
        return FeasibilityResult(True, witness, None)
    return FeasibilityResult(
        False, None,
        _hall_conflict(adjacency, variables, values, match_x, match_v),
    )


def _supported_edges(
    adjacency: Mapping, variables: list, m: int, match_v: list
) -> set:
    """Edges appearing in at least one perfect matching (Dulmage-Mendelsohn).

    Given a matching covering every variable, orient matched edges
    value -> variable and free edges variable -> value.  A free edge is
    supported iff its endpoints share an SCC (alternating cycle), or its
    value can reach an unmatched value (alternating path -- needed when
    there are more values than variables).
    """
    n = len(variables)
    base = n
    total = n + m
    forward = [[] for _ in range(total)]
    backward = [[] for _ in range(total)]

    for index, name in enumerate(variables):
        for value in adjacency[name]:
            forward[index].append(base + value)
            backward[base + value].append(index)
    for value, owner in enumerate(match_v):
        forward[base + value].append(owner)
        backward[owner].append(base + value)

    seen = [False] * total
    order: list = []
    for start in range(total):
        if seen[start]:
            continue
        seen[start] = True
        stack = [(start, 0)]
        while stack:
            node, edge_pos = stack[-1]
            if edge_pos < len(forward[node]):
                nxt = forward[node][edge_pos]
                stack[-1] = (node, edge_pos + 1)
                if not seen[nxt]:
                    seen[nxt] = True
                    stack.append((nxt, 0))
            else:
                order.append(node)
                stack.pop()

    component = [-1] * total
    component_count = 0
    for start in reversed(order):
        if component[start] != -1:
            continue
        component[start] = component_count
        stack = [start]
        while stack:
            node = stack.pop()
            for prv in backward[node]:
                if component[prv] == -1:
                    component[prv] = component_count
                    stack.append(prv)
        component_count += 1

    # Nodes from which an unmatched value is reachable along forward arcs.
    can_reach_free = [False] * total
    stack = [base + value for value, owner in enumerate(match_v) if owner == -1]
    for node in stack:
        can_reach_free[node] = True
    while stack:
        node = stack.pop()
        for prv in backward[node]:
            if not can_reach_free[prv]:
                can_reach_free[prv] = True
                stack.append(prv)

    supported: set = set()
    for index, name in enumerate(variables):
        for value in adjacency[name]:
            value_node = base + value
            in_cycle = component[index] == component[value_node]
            if match_v[value] == index or in_cycle or can_reach_free[value_node]:
                supported.add((name, value))
    return supported


@dataclass(frozen=True)
class PropagationResult:
    feasible: bool
    """Pruned domains: every surviving value has a supporting solution."""
    pruned_domains: dict | None
    """Values removed per variable, or None when infeasible."""
    removed: dict | None
    hall_conflict: HallConflict | None


def propagate(domains: Mapping) -> PropagationResult:
    """Global support filtering for the allDifferent constraint.

    A ``(variable, value)`` pair survives iff some perfect matching uses
    that edge, so the value participates in at least one solution.  This
    removes values that pairwise / "already-assigned" checks leave behind.
    """
    variables = list(domains)
    values, value_index = _value_index(domains)
    adjacency = _adjacency(domains, value_index)
    match_x, match_v, size = _maximum_matching(
        adjacency, len(variables), len(values)
    )
    if size != len(variables):
        return PropagationResult(
            False, None, None,
            _hall_conflict(adjacency, variables, values, match_x, match_v),
        )
    supported = _supported_edges(adjacency, variables, len(values), match_v)
    pruned = {}
    removed = {}
    for name in variables:
        kept = []
        dropped = []
        for value in domains[name]:
            target = kept if (name, value_index[value]) in supported else dropped
            target.append(value)
        pruned[name] = kept
        removed[name] = dropped
    return PropagationResult(True, pruned, removed, None)
