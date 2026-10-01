"""Core solver: feasible linearization-point intervals for stack histories.

Model
-----
Every event time (call/return) becomes a candidate slot.  A linearization
assigns each operation a distinct slot inside its [call, return] interval such
that simulating the operations in slot order on a sequential stack reproduces
the observed results (pop on an empty stack returns "EMPTY").

For every completed operation we report the intersection of its feasible
linearization-point intervals, i.e. [min, max] slot it can take in any valid
linearization.  Pending operations (called, not yet returned) can only extend
the unknown: if the completed sub-history is infeasible on its own but becomes
feasible when pending operations are allowed to participate, the status is
UNKNOWN rather than INFEASIBLE.
"""

from __future__ import annotations

import bisect
import math
import time
from dataclasses import dataclass
from typing import Dict, List, Optional, Sequence, Set, Tuple

EMPTY = "EMPTY"
NEG_INF = float("-inf")
POS_INF = float("inf")

# Skip the O(slots^2 * ops) Hall-interval propagation for very large histories.
MAX_HALL_SLOTS = 64
# Deadline check granularity (backtracking nodes between clock reads).
_TICK_MASK = 0xFF


class SolveTimeout(Exception):
    """Raised internally when the solver deadline is exceeded."""


@dataclass(frozen=True)
class Op:
    id: str
    kind: str  # "push" | "pop"
    arg: object = None
    result: object = None  # pop result: a value or EMPTY
    call: float = 0
    ret: Optional[float] = None  # None => pending (no return yet)

    @property
    def pending(self) -> bool:
        return self.ret is None


@dataclass
class Result:
    status: str  # "OK" | "INFEASIBLE" | "UNKNOWN" | "TIMEOUT"
    intervals: Optional[Dict[str, list]] = None
    conflict: Optional[List[str]] = None

    def to_dict(self) -> dict:
        return {
            "status": self.status,
            "intervals": self.intervals,
            "conflict": self.conflict,
        }


def _predecessors(ops: Sequence[Op]) -> List[int]:
    """Real-time precedence bitmask: i must linearize before j if ret_i <= call_j."""
    n = len(ops)
    pred = [0] * n
    for i, a in enumerate(ops):
        if a.ret is None:
            continue
        for j, b in enumerate(ops):
            if i != j and a.ret <= b.call:
                pred[j] |= 1 << i
    return pred


def _apply(op: Op, stack: tuple) -> Optional[tuple]:
    """Simulate one operation; return the new stack or None if inconsistent."""
    if op.kind == "push":
        return stack + (op.arg,)
    if not stack:
        return stack if (op.pending or op.result == EMPTY) else None
    if op.pending or op.result == stack[-1]:
        return stack[:-1]
    return None


def propagate(domains: List[Set[float]]) -> bool:
    """All-different interval propagation.  Returns False on a Hall violation."""
    all_slots = sorted(set().union(*domains)) if domains else []
    changed = True
    while changed:
        changed = False
        singletons: Set[float] = set()
        for dom in domains:
            if len(dom) == 1:
                singletons.update(dom)
        for dom in domains:
            if len(dom) > 1 and dom & singletons:
                dom -= singletons
                changed = True
        if any(not dom for dom in domains):
            return False
        if 0 < len(all_slots) <= MAX_HALL_SLOTS:
            for lo_idx, lo in enumerate(all_slots):
                for hi_idx in range(lo_idx, len(all_slots)):
                    hi = all_slots[hi_idx]
                    width = hi_idx - lo_idx + 1
                    subset = [
                        k
                        for k, dom in enumerate(domains)
                        if dom and min(dom) >= lo and max(dom) <= hi
                    ]
                    if len(subset) > width:
                        return False
                    if len(subset) == width:
                        blocked = set(all_slots[lo_idx : hi_idx + 1])
                        in_subset = set(subset)
                        for k, dom in enumerate(domains):
                            if k not in in_subset and dom & blocked:
                                dom -= blocked
                                changed = True
            if any(not dom for dom in domains):
                return False
    return True


class _Engine:
    """Backtracking search over linearization orders with slot assignment."""

    def __init__(self, ops: Sequence[Op], domains: Sequence[Sequence[float]], deadline: float):
        self.ops = list(ops)
        self.domains = [tuple(sorted(d)) for d in domains]
        self.deadline = deadline
        self.pred = _predecessors(self.ops)
        self.nodes = 0

    def _tick(self) -> None:
        self.nodes += 1
        if self.nodes & _TICK_MASK == 0 and time.monotonic() > self.deadline:
            raise SolveTimeout

    def _check_entry(self) -> None:
        if time.monotonic() > self.deadline:
            raise SolveTimeout

    def _next_slot(self, i: int, last: float) -> Optional[float]:
        dom = self.domains[i]
        idx = bisect.bisect_right(dom, last)
        return dom[idx] if idx < len(dom) else None

    def feasible(self) -> bool:
        """Decide whether any valid linearization exists (memoized)."""
        self._check_entry()
        n = len(self.ops)
        full = (1 << n) - 1
        pred = self.pred
        memo: set = set()

        def bt(mask: int, stack: tuple, last: float) -> bool:
            self._tick()
            if mask == full:
                return True
            key = (mask, stack, last)
            if key in memo:
                return False
            for i in range(n):
                bit = 1 << i
                if mask & bit or (pred[i] & ~mask):
                    continue
                slot = self._next_slot(i, last)
                if slot is None:
                    continue
                new_stack = _apply(self.ops[i], stack)
                if new_stack is None:
                    continue
                if bt(mask | bit, new_stack, slot):
                    return True
            memo.add(key)
            return False

        return bt(0, (), NEG_INF)

    def collect_intervals(self):
        """Enumerate all valid linearizations; return (found, lo, hi) per op."""
        self._check_entry()
        n = len(self.ops)
        full = (1 << n) - 1
        pred = self.pred
        lo: List[Optional[float]] = [None] * n
        hi: List[Optional[float]] = [None] * n
        order: List[int] = []
        found = False

        def record() -> None:
            cur = NEG_INF
            earliest = {}
            for i in order:
                cur = self._next_slot(i, cur)
                earliest[i] = cur
            cur = POS_INF
            latest = {}
            for i in reversed(order):
                dom = self.domains[i]
                idx = bisect.bisect_left(dom, cur) - 1
                cur = dom[idx]
                latest[i] = cur
            for i in order:
                lo[i] = earliest[i] if lo[i] is None else min(lo[i], earliest[i])
                hi[i] = latest[i] if hi[i] is None else max(hi[i], latest[i])

        def bt(mask: int, stack: tuple, last: float) -> None:
            nonlocal found
            self._tick()
            if mask == full:
                found = True
                record()
                return
            for i in range(n):
                bit = 1 << i
                if mask & bit or (pred[i] & ~mask):
                    continue
                slot = self._next_slot(i, last)
                if slot is None:
                    continue
                new_stack = _apply(self.ops[i], stack)
                if new_stack is None:
                    continue
                order.append(i)
                bt(mask | bit, new_stack, slot)
                order.pop()

        bt(0, (), NEG_INF)
        return found, lo, hi


def _completed_domains(ops: Sequence[Op]) -> List[Set[float]]:
    slots = sorted({op.call for op in ops} | {op.ret for op in ops})
    return [{t for t in slots if op.call <= t <= op.ret} for op in ops]


def _feasible_completed(ops: Sequence[Op], deadline: float) -> bool:
    domains = _completed_domains(ops)
    if not propagate(domains):
        return False
    return _Engine(ops, domains, deadline).feasible()


def _feasible_with_pending(completed: Sequence[Op], pending: Sequence[Op], deadline: float) -> bool:
    ops = list(completed) + list(pending)
    real_slots = sorted(
        {op.call for op in ops} | {op.ret for op in completed}
    )
    base = (real_slots[-1] + 1) if real_slots else 0
    virtual = [base + k for k in range(len(pending))]
    slots = real_slots + virtual
    domains: List[Set[float]] = []
    for op in completed:
        domains.append({t for t in real_slots if op.call <= t <= op.ret})
    for op in pending:
        domains.append({t for t in slots if t >= op.call})
    if not propagate(domains):
        return False
    return _Engine(ops, domains, deadline).feasible()


def _minimal_conflict(completed: Sequence[Op], deadline: float) -> List[str]:
    """Greedy minimal infeasible subset (unsat core) of the completed ops."""
    current = list(completed)
    for op in list(current):
        trial = [x for x in current if x is not op]
        if not _feasible_completed(trial, deadline):
            current = trial
    return [op.id for op in current]


def solve(ops: Sequence[Op], timeout_ms: float) -> Result:
    """Solve a parsed history; see module docstring for the semantics."""
    deadline = time.monotonic() + max(timeout_ms, 0) / 1000.0
    completed = [op for op in ops if not op.pending]
    pending = [op for op in ops if op.pending]

    domains = _completed_domains(completed)
    domains_ok = propagate(domains)

    def tightened() -> Dict[str, list]:
        return {
            op.id: ([min(dom), max(dom)] if dom else None)
            for op, dom in zip(completed, domains)
        }

    if domains_ok:
        engine = _Engine(completed, domains, deadline)
        try:
            found, lo, hi = engine.collect_intervals()
        except SolveTimeout:
            return Result("TIMEOUT", intervals=tightened(), conflict=None)
        if found:
            intervals = {
                op.id: [lo[i], hi[i]] for i, op in enumerate(completed)
            }
            return Result("OK", intervals=intervals, conflict=None)

    # Completed sub-history is infeasible on its own.
    if pending:
        try:
            if _feasible_with_pending(completed, pending, deadline):
                return Result("UNKNOWN", intervals=None, conflict=None)
        except SolveTimeout:
            return Result("TIMEOUT", intervals=tightened(), conflict=None)
    try:
        conflict = _minimal_conflict(completed, deadline)
    except SolveTimeout:
        return Result("TIMEOUT", intervals=tightened(), conflict=None)
    return Result("INFEASIBLE", intervals=None, conflict=conflict)
