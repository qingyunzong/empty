"""Linearizability solver for stack histories.

Computes, for every completed operation, the feasible interval for its
linearization point: the projection (tightest enclosing bounds) of the LP
feasible region over all valid linearization orders, intersected with the
operation's own [start, end] window.

Statuses:
  OK         - completed ops are linearizable on their own; intervals are exact.
  INFEASIBLE - completed ops cannot be linearized no matter what pending ops do;
               a (greedily minimized) conflict set of operation ids is reported.
  UNKNOWN    - completed ops alone are infeasible, but some assumption about
               pending operations makes the history linearizable.
  TIMEOUT    - the search exceeded the time budget; intervals are tightened as
               far as was proven before the deadline.
"""
from __future__ import annotations

import math
import time
from dataclasses import dataclass, field
from typing import Optional

from .model import EMPTY, Operation

OK = "OK"
INFEASIBLE = "INFEASIBLE"
UNKNOWN = "UNKNOWN"
TIMEOUT = "TIMEOUT"


class _Timeout(Exception):
    pass


@dataclass
class Result:
    status: str
    intervals: dict = field(default_factory=dict)  # op id -> [lo, hi]
    conflict: list = field(default_factory=list)   # op ids


def _predecessors(ops: list[Operation]) -> list[set[int]]:
    """Real-time precedence: j must linearize before i if end_j <= start_i."""
    preds: list[set[int]] = [set() for _ in ops]
    for j, opj in enumerate(ops):
        if opj.end is None:
            continue
        for i, opi in enumerate(ops):
            if i != j and opj.end <= opi.start:
                preds[i].add(j)
    return preds


def _propagate(ops: list[Operation]) -> tuple[dict, dict]:
    """Interval constraint propagation over real-time precedence edges.

    For an edge j -> i we have t_j <= t_i, so lo_i >= lo_j and hi_j <= hi_i.
    Iterated to a fixpoint. Pending ops have hi = +inf.
    """
    lo = {op.id: op.start for op in ops}
    hi = {op.id: (op.end if op.end is not None else math.inf) for op in ops}
    preds = _predecessors(ops)
    changed = True
    while changed:
        changed = False
        for i, op in enumerate(ops):
            for j in preds[i]:
                pred = ops[j]
                if lo[pred.id] > lo[op.id]:
                    lo[op.id] = lo[pred.id]
                    changed = True
                if hi[op.id] < hi[pred.id]:
                    hi[pred.id] = hi[op.id]
                    changed = True
    return lo, hi


def _check(deadline: float) -> None:
    if time.monotonic() >= deadline:
        raise _Timeout


def _enumerate(ops: list[Operation], deadline: float, find_all: bool,
               best: Optional[dict] = None) -> bool:
    """Backtracking search over linearization orders.

    Respects real-time precedence, per-op LP windows, and stack (LIFO)
    semantics. Returns True if at least one valid order exists. When
    ``find_all`` is true, every valid order is visited and ``best`` accumulates
    per-op [min_lo, max_hi] LP bounds (completed ops only).
    """
    n = len(ops)
    preds = _predecessors(ops)
    succs: list[list[int]] = [[] for _ in ops]
    for i in range(n):
        for j in preds[i]:
            succs[j].append(i)
    starts = [op.start for op in ops]
    ends = [op.end if op.end is not None else math.inf for op in ops]
    indeg = [len(preds[i]) for i in range(n)]
    placed = [False] * n
    stack: list = []
    order: list[int] = []
    if best is None:
        best = {}
    found = False
    nodes = 0

    def record() -> None:
        m = len(order)
        earliest = [0.0] * m
        latest = [0.0] * m
        acc = -math.inf
        for k in range(m):
            acc = max(acc, starts[order[k]])
            earliest[k] = acc
        acc = math.inf
        for k in range(m - 1, -1, -1):
            acc = min(acc, ends[order[k]])
            latest[k] = acc
        for k in range(m):
            op = ops[order[k]]
            if op.pending:
                continue
            entry = best.setdefault(op.id, [math.inf, -math.inf])
            if earliest[k] < entry[0]:
                entry[0] = earliest[k]
            if latest[k] > entry[1]:
                entry[1] = latest[k]

    def rec(cur_lo: float) -> bool:
        nonlocal found, nodes
        nodes += 1
        if (nodes & 0x3FF) == 0:
            _check(deadline)
        if len(order) == n:
            found = True
            record()
            return not find_all
        for i in range(n):
            if placed[i] or indeg[i]:
                continue
            est = max(cur_lo, starts[i])
            if est > ends[i]:
                continue
            op = ops[i]
            pushed = False
            popped = None
            if op.kind == "push":
                stack.append(op.value)
                pushed = True
            else:
                v = op.value
                if v is None:  # pending pop with unknown return
                    if not stack:
                        continue
                    popped = stack.pop()
                elif v == EMPTY:
                    if stack:
                        continue
                else:
                    if not stack or stack[-1] != v:
                        continue
                    popped = stack.pop()
            placed[i] = True
            order.append(i)
            for s in succs[i]:
                indeg[s] -= 1
            stop = rec(est)
            for s in succs[i]:
                indeg[s] += 1
            order.pop()
            placed[i] = False
            if pushed:
                stack.pop()
            elif popped is not None:
                stack.append(popped)
            if stop:
                return True
        return False

    rec(-math.inf)
    return found


def _conflict(completed: list[Operation], deadline: float) -> list[str]:
    """Greedily minimize an infeasible set of completed operations."""
    current = list(completed)
    for op in list(current):
        _check(deadline)
        trial = [o for o in current if o is not op]
        if not _enumerate(trial, deadline, find_all=False):
            current = trial
    return sorted(o.id for o in current)


def solve(ops: list[Operation], timeout_ms: float) -> Result:
    deadline = time.monotonic() + max(timeout_ms, 0) / 1000.0
    completed = [op for op in ops if not op.pending]
    pending = [op for op in ops if op.pending]

    lo, hi = _propagate(ops)
    propagated = {op.id: [lo[op.id], hi[op.id]] for op in completed}

    def merged(best: dict) -> dict:
        out = {}
        for op in completed:
            entry = best.get(op.id)
            out[op.id] = list(entry) if entry is not None else list(propagated[op.id])
        return out

    best: dict = {}
    try:
        _check(deadline)
        if _enumerate(completed, deadline, find_all=True, best=best):
            return Result(OK, merged(best), [])
        if pending and _enumerate(completed + pending, deadline, find_all=False):
            return Result(UNKNOWN, propagated, [])
        return Result(INFEASIBLE, propagated, _conflict(completed, deadline))
    except _Timeout:
        return Result(TIMEOUT, merged(best), [])
