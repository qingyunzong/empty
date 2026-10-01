"""Incremental recompute engine: model, dirty propagation, optimal selection."""

from __future__ import annotations

from dataclasses import dataclass
from heapq import heappop, heappush

EXIT_USAGE = 2
EXIT_CYCLE = 3
EXIT_UNKNOWN_NODE = 4


class RecomputeError(Exception):
    """Base error carrying a process exit code."""

    exit_code = 1


class UsageError(RecomputeError):
    exit_code = EXIT_USAGE


class CycleError(RecomputeError):
    exit_code = EXIT_CYCLE


class UnknownNodeError(RecomputeError):
    exit_code = EXIT_UNKNOWN_NODE


@dataclass
class Node:
    node_id: str
    cost: int
    value: int
    deps: tuple = ()
    dirty: bool = True


def _solution_key(ids, value, cost):
    """Ordering key for a candidate set.

    Higher total value wins; ties go to the lexicographically smallest
    ascending id sequence; remaining ties go to the smaller total cost.
    """
    return (-value, tuple(sorted(ids)), cost)


class Graph:
    def __init__(self):
        self.nodes = {}

    # -- mutation ------------------------------------------------------
    def set_node(self, node_id, cost, value, deps=()):
        if cost < 0:
            raise UsageError(f"negative cost for node {node_id!r}: {cost}")
        for dep in deps:
            if dep != node_id and dep not in self.nodes:
                raise UnknownNodeError(f"unknown node: {dep}")
        self.nodes[node_id] = Node(
            node_id, cost, value, tuple(dict.fromkeys(deps)), True
        )
        self._check_cycle()
        self._mark_dirty_from(node_id)

    def update_cost(self, node_id, cost):
        if cost < 0:
            raise UsageError(f"negative cost for node {node_id!r}: {cost}")
        node = self.nodes.get(node_id)
        if node is None:
            raise UnknownNodeError(f"unknown node: {node_id}")
        node.cost = cost
        self._mark_dirty_from(node_id)

    def recompute(self, budget):
        """Select the optimal set within budget and mark it clean."""
        chosen = self.select(budget)
        for nid in chosen:
            self.nodes[nid].dirty = False
        return chosen

    # -- queries -------------------------------------------------------
    def clean_value(self, extra_clean=()):
        clean = {nid for nid, n in self.nodes.items() if not n.dirty}
        clean.update(extra_clean)
        return sum(self.nodes[nid].value for nid in clean)

    def select(self, budget):
        """Optimal dirty-closed subset within budget (exact branch & bound)."""
        if budget < 0:
            raise UsageError(f"negative budget: {budget}")
        order = self._dirty_topo()
        if not order:
            return []
        nodes = self.nodes
        dirty = set(order)

        direct_succ = {nid: [] for nid in order}
        for nid in order:
            for dep in nodes[nid].deps:
                if dep in dirty:
                    direct_succ[dep].append(nid)

        # transitive dirty successors: excluding a node forbids all of them
        tsucc = {nid: set() for nid in order}
        for nid in reversed(order):
            acc = tsucc[nid]
            for nxt in direct_succ[nid]:
                acc.add(nxt)
                acc |= tsucc[nxt]

        index = {nid: i for i, nid in enumerate(order)}
        suffix_pos = [0] * (len(order) + 1)
        for i in range(len(order) - 1, -1, -1):
            suffix_pos[i] = suffix_pos[i + 1] + max(0, nodes[order[i]].value)

        best_ids = ()
        best_key = _solution_key((), 0, 0)
        forbidden = [False] * len(order)
        chosen = []

        def recurse(i, cost, value):
            nonlocal best_ids, best_key
            if value + suffix_pos[i] < -best_key[0]:
                return
            if i == len(order):
                key = _solution_key(chosen, value, cost)
                if key < best_key:
                    best_key = key
                    best_ids = tuple(sorted(chosen))
                return
            nid = order[i]
            if forbidden[i]:
                recurse(i + 1, cost, value)
                return
            node = nodes[nid]
            if cost + node.cost <= budget:
                chosen.append(nid)
                recurse(i + 1, cost + node.cost, value + node.value)
                chosen.pop()
            marked = []
            for succ in tsucc[nid]:
                j = index[succ]
                if not forbidden[j]:
                    forbidden[j] = True
                    marked.append(j)
            recurse(i + 1, cost, value)
            for j in marked:
                forbidden[j] = False

        recurse(0, 0, 0)
        return list(best_ids)

    # -- internals -----------------------------------------------------
    def _mark_dirty_from(self, node_id):
        successors = self._successors()
        seen = set()
        stack = [node_id]
        while stack:
            cur = stack.pop()
            if cur in seen:
                continue
            seen.add(cur)
            self.nodes[cur].dirty = True
            stack.extend(successors[cur])

    def _successors(self):
        succ = {nid: [] for nid in self.nodes}
        for nid, node in self.nodes.items():
            for dep in node.deps:
                succ[dep].append(nid)
        return succ

    def _check_cycle(self):
        indeg = {nid: 0 for nid in self.nodes}
        for nid, node in self.nodes.items():
            for _ in node.deps:
                indeg[nid] += 1
        succ = self._successors()
        ready = [nid for nid, deg in indeg.items() if deg == 0]
        seen = 0
        while ready:
            cur = ready.pop()
            seen += 1
            for nxt in succ[cur]:
                indeg[nxt] -= 1
                if indeg[nxt] == 0:
                    ready.append(nxt)
        if seen != len(self.nodes):
            raise CycleError("dependency cycle detected")

    def _dirty_topo(self):
        dirty = {nid for nid, n in self.nodes.items() if n.dirty}
        indeg = {}
        succ = {nid: [] for nid in dirty}
        for nid in dirty:
            deps = [d for d in self.nodes[nid].deps if d in dirty]
            indeg[nid] = len(deps)
            for dep in deps:
                succ[dep].append(nid)
        heap = []
        for nid, deg in indeg.items():
            if deg == 0:
                heappush(heap, nid)
        order = []
        while heap:
            cur = heappop(heap)
            order.append(cur)
            for nxt in succ[cur]:
                indeg[nxt] -= 1
                if indeg[nxt] == 0:
                    heappush(heap, nxt)
        if len(order) != len(dirty):
            raise CycleError("dependency cycle detected")
        return order

    # -- serialization ---------------------------------------------------
    def to_dict(self):
        return {
            "nodes": {
                nid: {
                    "cost": n.cost,
                    "value": n.value,
                    "deps": list(n.deps),
                    "dirty": n.dirty,
                }
                for nid, n in sorted(self.nodes.items())
            }
        }

    @classmethod
    def from_dict(cls, data):
        graph = cls()
        for nid, nd in data.get("nodes", {}).items():
            graph.nodes[nid] = Node(
                nid,
                int(nd["cost"]),
                int(nd["value"]),
                tuple(nd.get("deps", ())),
                bool(nd.get("dirty", True)),
            )
        for node in graph.nodes.values():
            for dep in node.deps:
                if dep not in graph.nodes:
                    raise UnknownNodeError(f"unknown node: {dep}")
        graph._check_cycle()
        return graph
