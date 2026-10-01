"""Deterministic two-phase lock manager with S/X locks.

Semantics:
- Lock requests that conflict enter a per-resource FIFO wait queue.
- Fairness: a new request is granted immediately only if it is compatible
  with all current holders AND with every request already waiting in the
  queue (no jumping ahead of a waiting X lock).
- After every new wait edge is added, the waits-for graph is checked for
  cycles.  On a cycle the transaction with the largest txn_id on the cycle
  is aborted (DEADLOCK) and all of its locks are released.
- S -> X upgrades blocked by S locks held by other transactions take part
  in deadlock detection like any other wait.
- When a transaction ends (commit/abort) all of its locks are released and
  the wait queues are scanned in FIFO order, granting every request that
  can be satisfied.
"""

from __future__ import annotations

from dataclasses import dataclass


def _compatible(held: str, requested: str) -> bool:
    """Lock compatibility matrix: only S/S is compatible."""
    return held == "S" and requested == "S"


@dataclass
class _Request:
    txn: int
    mode: str


def _find_cycle(graph: dict) -> list | None:
    """Return one cycle of the directed graph as a list of nodes, or None.

    Deterministic: nodes and edges are visited in sorted order.
    """
    color: dict = {}
    stack: list = []

    def visit(node):
        color[node] = 1  # gray
        stack.append(node)
        for nxt in sorted(graph.get(node, ())):
            state = color.get(nxt, 0)
            if state == 1:
                return stack[stack.index(nxt):]
            if state == 0:
                found = visit(nxt)
                if found is not None:
                    return found
        stack.pop()
        color[node] = 2  # black
        return None

    for node in sorted(graph):
        if color.get(node, 0) == 0:
            found = visit(node)
            if found is not None:
                return found
    return None


class LockManager:
    """Deterministic lock manager driven by an explicit operation sequence."""

    def __init__(self):
        self._holders: dict = {}   # resource -> {txn: mode}
        self._queues: dict = {}    # resource -> [_Request] (FIFO)
        self._active: set = set()
        self._finished: set = set()
        self._events: list = []

    # ------------------------------------------------------------------
    # events
    # ------------------------------------------------------------------
    def drain_events(self) -> list:
        """Return and clear events produced since the last call."""
        events, self._events = self._events, []
        return events

    def _emit(self, **event) -> None:
        self._events.append(event)

    # ------------------------------------------------------------------
    # public operations
    # ------------------------------------------------------------------
    def begin(self, txn: int) -> None:
        if txn in self._active or txn in self._finished:
            self._emit(status="ERROR", message=f"txn {txn} already exists")
            return
        self._active.add(txn)
        self._emit(status="BEGUN", txn=txn)

    def lock(self, txn: int, resource: str, mode: str) -> None:
        if mode not in ("S", "X"):
            self._emit(status="ERROR", message=f"invalid lock mode {mode!r}")
            return
        if txn in self._finished:
            self._emit(status="ERROR", message=f"txn {txn} already finished")
            return
        self._active.add(txn)

        held = self._holders.get(resource, {}).get(txn)
        if held == "X" or held == mode:
            # Already held at equal or stronger mode.
            self._emit(status="GRANTED", txn=txn, resource=resource, mode=mode)
            return

        queue = self._queues.setdefault(resource, [])
        for req in queue:
            if req.txn == txn:
                # Already waiting on this resource.  Strengthen a queued
                # S request to X (upgrade while waiting); either way the
                # request stays queued and produces no output.
                if req.mode == "S" and mode == "X":
                    req.mode = "X"
                    self._resolve_deadlocks()
                return

        if self._can_grant(resource, txn, mode):
            self._holders.setdefault(resource, {})[txn] = mode
            self._emit(status="GRANTED", txn=txn, resource=resource, mode=mode)
            return

        # Blocked: enqueue (this covers S->X upgrades blocked by other
        # S holders as well) and check the waits-for graph for cycles.
        queue.append(_Request(txn, mode))
        self._resolve_deadlocks()

    def commit(self, txn: int) -> None:
        if txn not in self._active:
            self._emit(status="ERROR", message=f"txn {txn} is not active")
            return
        self._emit(status="COMMITTED", txn=txn)
        self._release(txn)

    def abort(self, txn: int) -> None:
        if txn not in self._active:
            self._emit(status="ERROR", message=f"txn {txn} is not active")
            return
        self._emit(status="ABORTED", txn=txn)
        self._release(txn)

    # ------------------------------------------------------------------
    # introspection (used by tests / verification)
    # ------------------------------------------------------------------
    def snapshot(self) -> dict:
        """Current lock holders: {resource: {txn: mode}}."""
        return {res: dict(holders) for res, holders in self._holders.items()}

    def is_active(self, txn: int) -> bool:
        return txn in self._active

    # ------------------------------------------------------------------
    # internals
    # ------------------------------------------------------------------
    def _can_grant(self, resource: str, txn: int, mode: str) -> bool:
        for other, held in self._holders.get(resource, {}).items():
            if other != txn and not _compatible(held, mode):
                return False
        for req in self._queues.get(resource, []):
            if req.txn != txn and not _compatible(req.mode, mode):
                return False
        return True

    def _release(self, txn: int) -> None:
        self._active.discard(txn)
        self._finished.add(txn)
        affected = []
        for resource, holders in self._holders.items():
            if txn in holders:
                del holders[txn]
                affected.append(resource)
        for resource, queue in self._queues.items():
            before = len(queue)
            queue[:] = [req for req in queue if req.txn != txn]
            if len(queue) != before and resource not in affected:
                affected.append(resource)
        for resource in affected:
            self._process_queue(resource)

    def _process_queue(self, resource: str) -> None:
        """Grant queued requests in FIFO order while satisfiable."""
        queue = self._queues.get(resource)
        if not queue:
            return
        holders = self._holders.setdefault(resource, {})
        while queue:
            req = queue[0]
            if req.txn not in self._active:
                queue.pop(0)
                continue
            if all(other == req.txn or _compatible(held, req.mode)
                   for other, held in holders.items()):
                queue.pop(0)
                holders[req.txn] = req.mode
                self._emit(status="GRANTED", txn=req.txn,
                           resource=resource, mode=req.mode)
            else:
                break

    def _wait_graph(self) -> dict:
        """Build the waits-for graph from queued requests.

        A queued request waits on every conflicting holder and on every
        conflicting request ahead of it in the FIFO queue.
        """
        graph: dict = {}
        for resource, queue in self._queues.items():
            holders = self._holders.get(resource, {})
            for index, req in enumerate(queue):
                edges = graph.setdefault(req.txn, set())
                for other, held in holders.items():
                    if other != req.txn and not _compatible(held, req.mode):
                        edges.add(other)
                for prior in queue[:index]:
                    if (prior.txn != req.txn
                            and not _compatible(prior.mode, req.mode)):
                        edges.add(prior.txn)
        return graph

    def _resolve_deadlocks(self) -> None:
        """Abort the max-txn-id victim of each cycle until none remain."""
        while True:
            cycle = _find_cycle(self._wait_graph())
            if cycle is None:
                return
            victim = max(cycle)
            self._emit(status="DEADLOCK", victim=victim, cycle=list(cycle))
            self._release(victim)
