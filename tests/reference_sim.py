"""Independent reference waits-for-graph simulator.

Written separately from lockmgr.manager (explicit adjacency-set graph,
different code structure) so it can serve as a cross-check oracle for
randomized differential testing.  Implements the same deterministic
policy: fair FIFO queues, S/X compatibility, cycle -> abort max txn_id.
"""

from collections import defaultdict


def _compat(mode_a, mode_b):
    return mode_a == "S" and mode_b == "S"


def _find_cycle(nodes, edges):
    """Iterative DFS cycle search; deterministic via sorted ordering."""
    WHITE, GRAY, BLACK = 0, 1, 2
    color = {n: WHITE for n in nodes}
    for start in sorted(nodes):
        if color[start] != WHITE:
            continue
        stack = [(start, iter(sorted(edges.get(start, ()))))]
        path = [start]
        color[start] = GRAY
        while stack:
            node, it = stack[-1]
            advanced = False
            for nxt in it:
                if color.get(nxt, WHITE) == GRAY:
                    return path[path.index(nxt):]
                if color.get(nxt, WHITE) == WHITE:
                    color[nxt] = GRAY
                    path.append(nxt)
                    stack.append((nxt, iter(sorted(edges.get(nxt, ())))))
                    advanced = True
                    break
            if not advanced:
                stack.pop()
                path.pop()
                color[node] = BLACK
    return None


class ReferenceSimulator:
    def __init__(self):
        self.holds = defaultdict(dict)      # resource -> {txn: mode}
        self.waitq = defaultdict(list)      # resource -> [[txn, mode], ...]
        self.active = set()
        self.done = set()
        self.deadlock_victims = []

    # -- operations ----------------------------------------------------
    def lock(self, txn, resource, mode):
        if txn in self.done:
            return
        self.active.add(txn)
        held = self.holds[resource].get(txn)
        if held == "X" or held == mode:
            return
        for req in self.waitq[resource]:
            if req[0] == txn:
                if req[1] == "S" and mode == "X":
                    req[1] = "X"
                    self._check_deadlock()
                return
        blocked = any(
            other != txn and not _compat(om, mode)
            for other, om in self.holds[resource].items()
        ) or any(
            qt != txn and not _compat(qm, mode)
            for qt, qm in self.waitq[resource]
        )
        if blocked:
            self.waitq[resource].append([txn, mode])
            self._check_deadlock()
        else:
            self.holds[resource][txn] = mode

    def commit(self, txn):
        if txn in self.active:
            self._release(txn)

    def abort(self, txn):
        if txn in self.active:
            self._release(txn)

    # -- internals ------------------------------------------------------
    def _release(self, txn):
        self.active.discard(txn)
        self.done.add(txn)
        touched = []
        for resource in list(self.holds):
            if txn in self.holds[resource]:
                del self.holds[resource][txn]
                touched.append(resource)
        for resource in list(self.waitq):
            before = len(self.waitq[resource])
            self.waitq[resource] = [r for r in self.waitq[resource]
                                    if r[0] != txn]
            if len(self.waitq[resource]) != before and resource not in touched:
                touched.append(resource)
        for resource in touched:
            self._wake(resource)

    def _wake(self, resource):
        queue = self.waitq[resource]
        while queue:
            txn, mode = queue[0]
            if txn not in self.active:
                queue.pop(0)
                continue
            if all(other == txn or _compat(om, mode)
                   for other, om in self.holds[resource].items()):
                queue.pop(0)
                self.holds[resource][txn] = mode
            else:
                break

    def _graph(self):
        nodes = set()
        edges = defaultdict(set)
        for resource, queue in self.waitq.items():
            for index, (txn, mode) in enumerate(queue):
                nodes.add(txn)
                for other, om in self.holds[resource].items():
                    if other != txn and not _compat(om, mode):
                        edges[txn].add(other)
                for qt, qm in queue[:index]:
                    if qt != txn and not _compat(qm, mode):
                        edges[txn].add(qt)
        return nodes, edges

    def _check_deadlock(self):
        while True:
            nodes, edges = self._graph()
            cycle = _find_cycle(nodes, edges)
            if cycle is None:
                return
            victim = max(cycle)
            self.deadlock_victims.append(victim)
            self._release(victim)
