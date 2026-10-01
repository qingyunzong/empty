"""Directed unweighted graph with savepoint/rollback and witness paths."""

from collections import deque


class OpError(Exception):
    """Raised for malformed operations or invalid arguments."""


class Graph:
    def __init__(self):
        self.n = 0
        self.adj = []
        self.snapshots = {}
        self.next_id = 1

    def init(self, n):
        if not isinstance(n, int) or isinstance(n, bool) or n < 0:
            raise OpError(f"init: invalid node count {n!r}")
        self.n = n
        self.adj = [set() for _ in range(n)]
        self.snapshots = {}
        self.next_id = 1

    def _node(self, x):
        if not isinstance(x, int) or isinstance(x, bool) or not (0 <= x < self.n):
            raise OpError(f"invalid node {x!r} for graph of size {self.n}")
        return x

    def insert(self, u, v):
        u, v = self._node(u), self._node(v)
        self.adj[u].add(v)  # set semantics: duplicate inserts are idempotent

    def delete(self, u, v):
        u, v = self._node(u), self._node(v)
        self.adj[u].discard(v)

    def savepoint(self):
        sid = self.next_id
        self.next_id += 1
        self.snapshots[sid] = [set(s) for s in self.adj]
        return sid

    def rollback(self, sid):
        if sid not in self.snapshots:
            raise KeyError(sid)
        # Deep-copy so later mutations cannot alias the stored snapshot.
        self.adj = [set(s) for s in self.snapshots[sid]]

    def reachable(self, u, v):
        u, v = self._node(u), self._node(v)
        dist = [-1] * self.n
        dist[u] = 0
        queue = deque([u])
        while queue:
            x = queue.popleft()
            if x == v:
                return True
            for w in self.adj[x]:
                if dist[w] < 0:
                    dist[w] = dist[x] + 1
                    queue.append(w)
        return False

    def witness(self, u, v):
        """Lexicographically smallest shortest path u..v, or None."""
        u, v = self._node(u), self._node(v)
        # BFS distances *to* v on the reversed graph.
        dist = [-1] * self.n
        dist[v] = 0
        queue = deque([v])
        while queue:
            x = queue.popleft()
            for a in range(self.n):
                if x in self.adj[a] and dist[a] < 0:
                    dist[a] = dist[x] + 1
                    queue.append(a)
        if dist[u] < 0:
            return None
        path = [u]
        while path[-1] != v:
            x = path[-1]
            path.append(min(w for w in self.adj[x] if dist[w] == dist[x] - 1))
        return path
