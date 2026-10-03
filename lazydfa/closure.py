"""Epsilon-closure index based on SCC condensation of the epsilon graph.

Strongly connected components of the epsilon graph are computed once per
epsilon-graph version; the epsilon closure of any state set is then the
union of the member states of all components reachable from the set's
components in the condensation DAG.  Results are cached per component
and per queried set, and the whole index is rebuilt whenever the NFA's
epsilon version changes (so deleting an epsilon edge that splits an SCC
never leaves a stale closure behind).
"""

from __future__ import annotations

from typing import Dict, FrozenSet, Iterable, List

from .nfa import NFA


def _tarjan_sccs(nodes: Iterable[int], adj: List[List[int]]) -> List[List[int]]:
    index_of: Dict[int, int] = {}
    low: Dict[int, int] = {}
    on_stack = set()
    stack: List[int] = []
    comps: List[List[int]] = []
    for root in nodes:
        if root in index_of:
            continue
        index_of[root] = low[root] = len(index_of)
        stack.append(root)
        on_stack.add(root)
        work = [(root, iter(adj[root]))]
        while work:
            node, it = work[-1]
            descended = False
            for w in it:
                if w not in index_of:
                    index_of[w] = low[w] = len(index_of)
                    stack.append(w)
                    on_stack.add(w)
                    work.append((w, iter(adj[w])))
                    descended = True
                    break
                elif w in on_stack:
                    low[node] = min(low[node], index_of[w])
            if descended:
                continue
            work.pop()
            if work:
                parent = work[-1][0]
                low[parent] = min(low[parent], low[node])
            if low[node] == index_of[node]:
                comp = []
                while True:
                    w = stack.pop()
                    on_stack.discard(w)
                    comp.append(w)
                    if w == node:
                        break
                comps.append(sorted(comp))
    return comps


class ClosureIndex:
    def __init__(self, nfa: NFA):
        self._nfa = nfa
        self._eps_version = -1
        self._comp_of: List[int] = []
        self._comp_reach: List[FrozenSet[int]] = []
        self._set_cache: Dict[FrozenSet[int], FrozenSet[int]] = {}
        self._ensure()

    def _ensure(self) -> None:
        if self._eps_version == self._nfa.eps_version:
            return
        nfa = self._nfa
        adj = [[] for _ in range(nfa.num_states)]
        for s in range(nfa.num_states):
            for e in nfa.epsilon_edges_from(s):
                adj[s].append(e.dst)
        comps = _tarjan_sccs(range(nfa.num_states), adj)
        comp_of = [0] * nfa.num_states
        for cid, members in enumerate(comps):
            for s in members:
                comp_of[s] = cid
        # Condensation DAG.
        dag: List[set] = [set() for _ in comps]
        for s in range(nfa.num_states):
            for t in adj[s]:
                cu, cv = comp_of[s], comp_of[t]
                if cu != cv:
                    dag[cu].add(cv)
        # Reachable-state union per component (iterative DFS over the DAG).
        membersets = [frozenset(m) for m in comps]
        reach: List[FrozenSet[int]] = [frozenset()] * len(comps)
        for cid in range(len(comps)):
            seen = set()
            todo = [cid]
            while todo:
                c = todo.pop()
                if c in seen:
                    continue
                seen.add(c)
                todo.extend(dag[c] - seen)
            acc = frozenset().union(*(membersets[c] for c in seen))
            reach[cid] = acc
        self._comp_of = comp_of
        self._comp_reach = reach
        self._set_cache = {}
        self._eps_version = nfa.eps_version

    def closure(self, states: Iterable[int]) -> FrozenSet[int]:
        """Epsilon closure of a set of states."""
        self._ensure()
        key = frozenset(states)
        hit = self._set_cache.get(key)
        if hit is not None:
            return hit
        comps = {self._comp_of[s] for s in key}
        result = frozenset().union(*(self._comp_reach[c] for c in comps)) \
            if comps else frozenset()
        self._set_cache[key] = result
        return result

    def component_of(self, state: int) -> int:
        self._ensure()
        return self._comp_of[state]
