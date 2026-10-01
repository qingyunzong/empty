"""Epsilon-closure index built on SCC condensation of the epsilon graph.

The epsilon subgraph is condensed into strongly connected components
(Kosaraju, iterative).  The epsilon closure of any state set is then a
union of precomputed per-SCC reachability sets over the condensation
DAG, so closures are shared instead of recomputed per query.

The index is rebuilt lazily whenever the NFA epsilon version changes,
so removing an epsilon edge that splits an SCC can never leave a stale
closure behind.
"""
from __future__ import annotations

from .nfa import NFA


class ClosureIndex:
    def __init__(self, nfa: NFA):
        self._nfa = nfa
        self._built_eps_version = -1
        self._scc_of: list[int] = []
        self._scc_members: list[tuple[int, ...]] = []
        self._scc_closure: list[frozenset[int]] = []
        self._scc_deps: list[frozenset[int]] = []

    # -- public API ---------------------------------------------------
    def closure(self, states) -> frozenset[int]:
        """Epsilon closure of a set of NFA states."""
        self._ensure()
        out: set[int] = set()
        for s in states:
            out |= self._scc_closure[self._scc_of[s]]
        return frozenset(out)

    def eps_deps(self, states) -> frozenset[int]:
        """Epsilon edge ids whose removal could change closure(states).

        Conservatively: every epsilon edge whose source lies inside the
        closure.  Edges outside the closure cannot influence it.
        """
        self._ensure()
        out: set[int] = set()
        for s in states:
            out |= self._scc_deps[self._scc_of[s]]
        return frozenset(out)

    def scc_of(self, state: int) -> int:
        self._ensure()
        return self._scc_of[state]

    # -- construction ---------------------------------------------------
    def _ensure(self) -> None:
        if self._built_eps_version != self._nfa.eps_version:
            self._recompute()

    def _recompute(self) -> None:
        nfa = self._nfa
        n = nfa.num_states
        adj: list[list[int]] = [[] for _ in range(n)]
        radj: list[list[int]] = [[] for _ in range(n)]
        eps_edges = []
        for e in nfa.edges.values():
            if e.is_epsilon:
                adj[e.src].append(e.dst)
                radj[e.dst].append(e.src)
                eps_edges.append(e)
        for lst in adj:
            lst.sort()
        for lst in radj:
            lst.sort()

        # Kosaraju pass 1: finish order on the epsilon graph (iterative).
        visited = [False] * n
        order: list[int] = []
        for root in range(n):
            if visited[root]:
                continue
            visited[root] = True
            stack = [(root, 0)]
            while stack:
                node, idx = stack[-1]
                if idx < len(adj[node]):
                    stack[-1] = (node, idx + 1)
                    nxt = adj[node][idx]
                    if not visited[nxt]:
                        visited[nxt] = True
                        stack.append((nxt, 0))
                else:
                    order.append(node)
                    stack.pop()

        # Kosaraju pass 2: components via reverse graph, in reverse
        # finish order.  Components are numbered in topological order
        # of the condensation DAG (sources first).
        scc_of = [-1] * n
        members: list[tuple[int, ...]] = []
        for root in reversed(order):
            if scc_of[root] != -1:
                continue
            cid = len(members)
            comp = []
            scc_of[root] = cid
            stack = [root]
            while stack:
                node = stack.pop()
                comp.append(node)
                for nb in radj[node]:
                    if scc_of[nb] == -1:
                        scc_of[nb] = cid
                        stack.append(nb)
            members.append(tuple(sorted(comp)))

        # Reachability over the condensation DAG.  Because component ids
        # are topological, iterating in reverse id order guarantees that
        # successor reachability sets are already final.
        nscc = len(members)
        reach: list[frozenset[int]] = [frozenset()] * nscc
        for cid in range(nscc - 1, -1, -1):
            r = {cid}
            for m in members[cid]:
                for nb in adj[m]:
                    cn = scc_of[nb]
                    if cn != cid:
                        r |= reach[cn]
            reach[cid] = frozenset(r)

        closures = []
        deps = []
        for cid in range(nscc):
            states: set[int] = set()
            for r in reach[cid]:
                states |= set(members[r])
            closures.append(frozenset(states))
            deps.append(frozenset(
                e.id for e in eps_edges if scc_of[e.src] in reach[cid]))

        self._scc_of = scc_of
        self._scc_members = members
        self._scc_closure = closures
        self._scc_deps = deps
        self._built_eps_version = nfa.eps_version
