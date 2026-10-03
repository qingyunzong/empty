"""Budgeted incremental recompute planner.

Model: nodes have a cost, a value and a list of dependencies
(predecessors).  Updating a node marks it and all transitive
successors dirty.  Given a budget, the planner selects a subset of the
dirty nodes to recompute such that

* feasibility: recomputing a node requires recomputing all of its
  dirty predecessors (clean predecessors need no work);
* budget: the sum of costs of selected nodes does not exceed budget;
* objective: maximize the sum of values of the selected nodes (which
  equals maximizing the total value of clean nodes afterwards);
* ties: among value-optimal sets pick the lexicographically smallest
  ascending id sequence.  A sequence that is a strict prefix of
  another is considered tied (this is what gives the next rule
  meaning); still tied -> smaller total cost; still tied -> fewer
  nodes.
"""

from __future__ import annotations

import sys


class RecalcError(Exception):
    """Base class for user-facing errors; exit_code is the CLI exit code."""

    exit_code = 1


class NegativeAmountError(RecalcError):
    """Negative cost or negative budget."""

    exit_code = 2


class CycleError(RecalcError):
    """Dependency cycle detected."""

    exit_code = 3


class UnknownNodeError(RecalcError):
    """Reference to an undefined node."""

    exit_code = 4


class Node:
    __slots__ = ("id", "cost", "value", "deps")

    def __init__(self, node_id, cost, value, deps):
        self.id = node_id
        self.cost = cost
        self.value = value
        self.deps = tuple(deps)


class Plan:
    """Result of a run/best query."""

    __slots__ = ("ids", "value", "cost")

    def __init__(self, ids, value, cost):
        self.ids = tuple(ids)
        self.value = value
        self.cost = cost

    def __eq__(self, other):
        return (
            isinstance(other, Plan)
            and self.ids == other.ids
            and self.value == other.value
            and self.cost == other.cost
        )

    def __repr__(self):
        return f"Plan(ids={self.ids!r}, value={self.value}, cost={self.cost})"


def _is_better(cand, best):
    """True if cand beats best under the tie-break rules.

    Each is a ``(value, rank_mask, cost)`` triple where bit ``r`` of
    ``rank_mask`` is set iff the node with id-rank ``r`` (ids sorted
    ascending) is in the set.
    """
    cand_value, cand_mask, cand_cost = cand
    best_value, best_mask, best_cost = best
    if cand_value != best_value:
        return cand_value > best_value
    diff = cand_mask ^ best_mask
    if diff == 0:
        return False
    lowest = diff & -diff
    if not (cand_mask & ~best_mask):
        # cand is a strict subset of best; its id sequence is a prefix
        # of best's iff every extra id of best sorts after all of cand's.
        if cand_mask.bit_length() < lowest.bit_length():
            if cand_cost != best_cost:
                return cand_cost < best_cost
            return cand_mask.bit_count() < best_mask.bit_count()
    elif not (best_mask & ~cand_mask):
        if best_mask.bit_length() < lowest.bit_length():
            if cand_cost != best_cost:
                return cand_cost < best_cost
            return cand_mask.bit_count() < best_mask.bit_count()
    # General lexicographic rule: the set owning the smallest differing
    # id has the lexicographically smaller sequence.
    return bool(cand_mask & lowest)


class RecalcGraph:
    def __init__(self):
        self._nodes = {}
        self._succ = {}
        self._dirty = set()

    def __contains__(self, node_id):
        return node_id in self._nodes

    def set_node(self, node_id, cost, value, deps=()):
        """Define (or redefine) a node; the node and its transitive
        successors become dirty."""
        if cost < 0:
            raise NegativeAmountError(f"negative cost {cost} for node {node_id!r}")
        deps = tuple(deps)
        for dep in deps:
            if dep not in self._nodes:
                raise UnknownNodeError(
                    f"unknown dependency {dep!r} of node {node_id!r}"
                )
        previous = self._nodes.get(node_id)
        self._nodes[node_id] = Node(node_id, cost, value, deps)
        self._rebuild_successors()
        if self._has_cycle():
            if previous is None:
                del self._nodes[node_id]
            else:
                self._nodes[node_id] = previous
            self._rebuild_successors()
            raise CycleError(f"dependency cycle involving node {node_id!r}")
        self._mark_dirty(node_id)

    def update_cost(self, node_id, cost):
        """Change a node's cost; the node and its transitive successors
        become dirty."""
        node = self._nodes.get(node_id)
        if node is None:
            raise UnknownNodeError(f"unknown node {node_id!r}")
        if cost < 0:
            raise NegativeAmountError(f"negative cost {cost} for node {node_id!r}")
        node.cost = cost
        self._mark_dirty(node_id)

    def dirty_ids(self):
        return sorted(self._dirty)

    def is_dirty(self, node_id):
        return node_id in self._dirty

    def best(self, budget):
        """Optimal recompute plan for the budget; does not change state."""
        if budget < 0:
            raise NegativeAmountError(f"negative budget {budget}")
        return _solve(self, budget)

    def run(self, budget):
        """Like best(), but the selected nodes become clean."""
        plan = self.best(budget)
        self._dirty.difference_update(plan.ids)
        return plan

    def _rebuild_successors(self):
        self._succ = {nid: [] for nid in self._nodes}
        for nid, node in self._nodes.items():
            for dep in node.deps:
                self._succ[dep].append(nid)

    def _has_cycle(self):
        indegree = {nid: len(node.deps) for nid, node in self._nodes.items()}
        stack = [nid for nid, deg in indegree.items() if deg == 0]
        seen = 0
        while stack:
            nid = stack.pop()
            seen += 1
            for succ in self._succ[nid]:
                indegree[succ] -= 1
                if indegree[succ] == 0:
                    stack.append(succ)
        return seen != len(self._nodes)

    def _mark_dirty(self, node_id):
        stack = [node_id]
        while stack:
            nid = stack.pop()
            if nid in self._dirty:
                continue
            self._dirty.add(nid)
            stack.extend(self._succ[nid])


def _solve(graph, budget):
    dirty = sorted(graph._dirty)
    count = len(dirty)
    if count == 0:
        return Plan((), 0, 0)
    if sys.getrecursionlimit() < count + 50:
        sys.setrecursionlimit(count + 50)
    nodes = graph._nodes
    index = {nid: i for i, nid in enumerate(dirty)}
    costs = [nodes[nid].cost for nid in dirty]
    values = [nodes[nid].value for nid in dirty]

    # Edges of the dirty-induced subgraph.
    preds = [[] for _ in range(count)]
    succs = [[] for _ in range(count)]
    for i, nid in enumerate(dirty):
        for dep in nodes[nid].deps:
            j = index.get(dep)
            if j is not None:
                preds[i].append(j)
                succs[j].append(i)

    # Ancestor/descendant bitmasks inside the dirty subgraph.  Since
    # `dirty` is sorted by id, bit position == id rank.
    indegree = [len(p) for p in preds]
    order = []
    stack = [i for i, deg in enumerate(indegree) if deg == 0]
    anc = [0] * count
    while stack:
        i = stack.pop()
        order.append(i)
        anc[i] |= 1 << i
        for p in preds[i]:
            anc[i] |= anc[p]
        for s in succs[i]:
            indegree[s] -= 1
            if indegree[s] == 0:
                stack.append(s)
    desc = [0] * count
    for i in reversed(order):
        desc[i] |= 1 << i
        for s in succs[i]:
            desc[i] |= desc[s]

    # Suffix sums of positive values: an optimistic bound for pruning.
    suffix = [0] * (count + 1)
    for i in range(count - 1, -1, -1):
        suffix[i] = suffix[i + 1] + (values[i] if values[i] > 0 else 0)

    best = [0, 0, 0]  # empty set: value 0, mask 0, cost 0

    def dfs(i, inc, exc, cost, value):
        if value + suffix[i] < best[0]:
            return
        if i == count:
            if _is_better((value, inc, cost), best):
                best[0] = value
                best[1] = inc
                best[2] = cost
            return
        if (inc | exc) >> i & 1:
            dfs(i + 1, inc, exc, cost, value)
            return
        # Include i: all dirty ancestors are forced in.
        add = anc[i] & ~inc
        add_cost = 0
        add_value = 0
        m = add
        while m:
            lsb = m & -m
            j = lsb.bit_length() - 1
            add_cost += costs[j]
            add_value += values[j]
            m ^= lsb
        if cost + add_cost <= budget:
            dfs(i + 1, inc | anc[i], exc, cost + add_cost, value + add_value)
        # Exclude i: all dirty descendants are forced out.
        dfs(i + 1, inc, exc | desc[i], cost, value)

    dfs(0, 0, 0, 0, 0)
    ids = tuple(dirty[r] for r in range(count) if best[1] >> r & 1)
    return Plan(ids, best[0], best[2])
