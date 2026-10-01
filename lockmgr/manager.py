"""Deterministic two-phase lock manager with S/X locks.

Semantics:
- Conflicting lock requests join a FIFO wait queue per resource.
- After every new wait edge, the wait-for graph is checked for cycles;
  on a cycle the transaction with the largest txn_id on the cycle is
  aborted (DEADLOCK) and all of its locks are released.
- S -> X upgrades blocked by other transactions' S locks participate in
  deadlock detection like any other wait.
- Releasing a transaction's locks wakes queued requests in FIFO order
  while they remain grantable.
"""

from __future__ import annotations

from dataclasses import dataclass
from enum import Enum
from typing import Dict, List, Optional, Set, Tuple


class LockMode(Enum):
    S = "S"
    X = "X"

    @staticmethod
    def parse(value: str) -> "LockMode":
        value = value.upper()
        if value == "S":
            return LockMode.S
        if value == "X":
            return LockMode.X
        raise ValueError(f"unknown lock mode: {value!r}")


class RequestStatus(Enum):
    GRANTED = "GRANTED"
    WAITING = "WAITING"
    DEADLOCK = "DEADLOCK"
    ERROR = "ERROR"


@dataclass
class LockRequest:
    txn_id: int
    mode: LockMode
    upgrade: bool = False


class _ResourceState:
    __slots__ = ("holders", "queue")

    def __init__(self) -> None:
        # txn_id -> currently held mode
        self.holders: Dict[int, LockMode] = {}
        # FIFO queue of waiting requests
        self.queue: List[LockRequest] = []


class LockManager:
    def __init__(self) -> None:
        self._resources: Dict[str, _ResourceState] = {}
        self._locks_held: Dict[int, Set[str]] = {}
        self._aborted: Set[int] = set()
        self._committed: Set[int] = set()

    # ------------------------------------------------------------------
    # public API
    # ------------------------------------------------------------------
    def lock(self, txn_id: int, resource: str, mode: LockMode) -> RequestStatus:
        """Process a lock request; returns its immediate status."""
        error = self._check_txn_active(txn_id)
        if error is not None:
            return error

        state = self._resources.setdefault(resource, _ResourceState())
        held = state.holders.get(txn_id)

        if held is mode or (held is LockMode.X):
            # Already covered by a held lock (idempotent re-request).
            return RequestStatus.GRANTED

        if held is LockMode.S and mode is LockMode.X:
            return self._upgrade(txn_id, resource, state)

        return self._acquire(txn_id, resource, mode, state)

    def commit(self, txn_id: int) -> RequestStatus:
        error = self._check_txn_active(txn_id)
        if error is not None:
            return error
        self._committed.add(txn_id)
        self._release_all(txn_id)
        return RequestStatus.GRANTED

    def abort(self, txn_id: int) -> RequestStatus:
        error = self._check_txn_active(txn_id)
        if error is not None:
            return error
        self._aborted.add(txn_id)
        self._release_all(txn_id)
        return RequestStatus.GRANTED

    def is_aborted(self, txn_id: int) -> bool:
        return txn_id in self._aborted

    def is_committed(self, txn_id: int) -> bool:
        return txn_id in self._committed

    def waiters(self, resource: str) -> List[Tuple[int, LockMode]]:
        state = self._resources.get(resource)
        if state is None:
            return []
        return [(req.txn_id, req.mode) for req in state.queue]

    def holders(self, resource: str) -> Dict[int, LockMode]:
        state = self._resources.get(resource)
        if state is None:
            return {}
        return dict(state.holders)

    # ------------------------------------------------------------------
    # acquisition / upgrade
    # ------------------------------------------------------------------
    def _acquire(
        self, txn_id: int, resource: str, mode: LockMode, state: _ResourceState
    ) -> RequestStatus:
        if self._grantable(state, txn_id, mode):
            state.holders[txn_id] = mode
            self._locks_held.setdefault(txn_id, set()).add(resource)
            return RequestStatus.GRANTED
        state.queue.append(LockRequest(txn_id, mode))
        self._detect_and_resolve_deadlock()
        return RequestStatus.WAITING

    def _upgrade(
        self, txn_id: int, resource: str, state: _ResourceState
    ) -> RequestStatus:
        others_hold_s = any(t != txn_id for t in state.holders)
        if not others_hold_s:
            state.holders[txn_id] = LockMode.X
            return RequestStatus.GRANTED
        # Blocked upgrade: the txn keeps its S lock and queues an X request.
        # It jumps ahead of any already-queued requests (it is a holder).
        state.queue.insert(0, LockRequest(txn_id, LockMode.X, upgrade=True))
        self._detect_and_resolve_deadlock()
        return RequestStatus.WAITING

    @staticmethod
    def _grantable(state: _ResourceState, txn_id: int, mode: LockMode) -> bool:
        if state.queue:
            return False  # FIFO fairness: never jump the queue
        if mode is LockMode.S:
            return all(m is LockMode.S for m in state.holders.values())
        return not state.holders

    # ------------------------------------------------------------------
    # deadlock detection
    # ------------------------------------------------------------------
    def _wait_for_graph(self) -> Dict[int, Set[int]]:
        edges: Dict[int, Set[int]] = {}
        for state in self._resources.values():
            # Waitee set: current holders plus, for non-upgrade waiters, any
            # upgrade request ahead of them in the queue (an upgrader still
            # holds S, so later waiters must also wait for it).
            for index, req in enumerate(state.queue):
                targets: Set[int] = set(state.holders)
                if not req.upgrade:
                    for ahead in state.queue[:index]:
                        if ahead.upgrade:
                            targets.add(ahead.txn_id)
                targets.discard(req.txn_id)
                if targets:
                    edges.setdefault(req.txn_id, set()).update(targets)
        return edges

    def _find_cycle(self, graph: Dict[int, Set[int]]) -> Optional[List[int]]:
        WHITE, GRAY, BLACK = 0, 1, 2
        color: Dict[int, int] = {}
        stack: List[int] = []

        def visit(node: int) -> Optional[List[int]]:
            color[node] = GRAY
            stack.append(node)
            for nxt in sorted(graph.get(node, ())):
                state = color.get(nxt, WHITE)
                if state == GRAY:
                    return stack[stack.index(nxt):]
                if state == WHITE:
                    found = visit(nxt)
                    if found is not None:
                        return found
            stack.pop()
            color[node] = BLACK
            return None

        for node in sorted(graph):
            if color.get(node, WHITE) == WHITE:
                found = visit(node)
                if found is not None:
                    return found
        return None

    def _detect_and_resolve_deadlock(self) -> None:
        while True:
            graph = self._wait_for_graph()
            cycle = self._find_cycle(graph)
            if cycle is None:
                return
            victim = max(cycle)
            self._aborted.add(victim)
            self._on_victim(victim)
            self._release_all(victim)

    def _on_victim(self, txn_id: int) -> None:
        """Hook called when a deadlock victim is chosen (before release)."""

    # ------------------------------------------------------------------
    # release / wake-up
    # ------------------------------------------------------------------
    def _release_all(self, txn_id: int) -> None:
        resources = self._locks_held.pop(txn_id, set())
        for resource in resources:
            state = self._resources[resource]
            state.holders.pop(txn_id, None)
        # Remove the txn's queued requests everywhere.
        for state in self._resources.values():
            state.queue = [req for req in state.queue if req.txn_id != txn_id]
        self._drain_queues()

    def _drain_queues(self) -> None:
        """Grant queued requests in FIFO order while possible; upgrading
        waiters that become grantable convert their S hold into X."""
        changed = True
        while changed:
            changed = False
            for resource in sorted(self._resources):
                state = self._resources[resource]
                while state.queue:
                    req = state.queue[0]
                    if req.upgrade:
                        grantable = not any(
                            t != req.txn_id for t in state.holders
                        )
                    elif req.mode is LockMode.S:
                        grantable = all(
                            m is LockMode.S for m in state.holders.values()
                        )
                    else:
                        grantable = not state.holders
                    if not grantable:
                        break
                    state.queue.pop(0)
                    state.holders[req.txn_id] = req.mode
                    self._locks_held.setdefault(req.txn_id, set()).add(resource)
                    changed = True

    # ------------------------------------------------------------------
    # helpers
    # ------------------------------------------------------------------
    def _check_txn_active(self, txn_id: int) -> Optional[RequestStatus]:
        if txn_id in self._aborted:
            return RequestStatus.ERROR
        if txn_id in self._committed:
            return RequestStatus.ERROR
        return None
