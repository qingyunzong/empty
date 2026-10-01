"""Backtracking linearizability checker with pending-operation handling.

Search strategy
---------------
We explore linearizations position by position.  An operation may be
placed next iff every operation that *must* precede it (its response was
observed before this operation's call, i.e. ``end_i <= start_j``) has
already been placed.  Explored ``(placed-set, object-state)`` pairs are
memoised, which is the key pruning that keeps the backtracking tractable.

Pending operations (no observed response) are *not* equated with
failure:

* Phase 1 searches a linearization of the completed operations only
  (pending operations may simply never take effect).  Success means the
  history is definitively LINEARIZABLE.
* Phase 2 additionally allows pending operations to take effect with
  *any* legal response.  If a linearization exists only under such an
  assumption the verdict is UNKNOWN (the missing responses decide it).
* If even phase 2 fails, every possible completion fails, so the
  history is NON_LINEARIZABLE.

If the number of explored states exceeds ``max_states`` the search
aborts and the verdict is UNKNOWN_RESOURCE -- never a false FAIL.
"""

from __future__ import annotations

import enum
import json
import sys
from dataclasses import dataclass, field
from typing import Any, List, Optional, Sequence

from .history import Operation

sys.setrecursionlimit(max(sys.getrecursionlimit(), 100000))


class Verdict(enum.Enum):
    LINEARIZABLE = "LINEARIZABLE"
    NON_LINEARIZABLE = "NON_LINEARIZABLE"
    UNKNOWN = "UNKNOWN"
    UNKNOWN_RESOURCE = "UNKNOWN_RESOURCE"


class ResourceLimitExceeded(Exception):
    """Raised when the explored-state budget is exhausted."""


@dataclass
class CheckResult:
    verdict: Verdict
    linearization: Optional[List[Operation]] = None
    conflict_prefix: Optional[List[Operation]] = None
    states_explored: int = 0
    note: str = ""


def _state_key(state: Any) -> str:
    try:
        return json.dumps(state, sort_keys=True)
    except TypeError:
        return repr(state)


def _predecessors(ops: Sequence[Operation]) -> List[frozenset]:
    n = len(ops)
    preds = [set() for _ in range(n)]
    for i in range(n):
        end_i = ops[i].end
        if end_i is None:
            continue  # pending ops never precede anything
        for j in range(n):
            if i != j and end_i <= ops[j].start:
                preds[j].add(i)
    return [frozenset(p) for p in preds]


def find_linearization(
    ops: Sequence[Operation],
    model,
    max_states: int,
    include_pending: bool,
    counter: List[int],
) -> Optional[List[Operation]]:
    """Return one legal linearization, or None if none exists.

    ``counter`` is a shared single-element list so the state budget is
    honoured across phases.  Raises ResourceLimitExceeded when the
    budget is exhausted.
    """
    n = len(ops)
    preds = _predecessors(ops)
    required = [i for i, op in enumerate(ops) if not op.pending]
    required_mask = 0
    for i in required:
        required_mask |= 1 << i

    placed = [False] * n
    unplaced_preds = [len(p) for p in preds]
    available = []
    for i in range(n):
        if unplaced_preds[i] == 0 and (include_pending or not ops[i].pending):
            available.append(i)

    visited = set()
    path: List[int] = []

    def dfs(state: Any, mask: int) -> bool:
        counter[0] += 1
        if counter[0] > max_states:
            raise ResourceLimitExceeded()
        if mask & required_mask == required_mask:
            return True  # all completed ops placed; pendings may be dropped
        key = (mask, _state_key(state))
        if key in visited:
            return False
        visited.add(key)
        for pos in range(len(available)):
            i = available[pos]
            if placed[i]:
                continue
            op = ops[i]
            if op.pending:
                next_state = model.step_pending(state, op)
            else:
                next_state = model.step_completed(state, op)
                if next_state is None:
                    continue  # recorded response illegal here: prune
            placed[i] = True
            path.append(i)
            newly = []
            for j in range(n):
                if not placed[j] and i in preds[j]:
                    unplaced_preds[j] -= 1
                    if unplaced_preds[j] == 0 and (
                        include_pending or not ops[j].pending
                    ):
                        available.append(j)
                        newly.append(j)
            if dfs(next_state, mask | (1 << i)):
                return True
            for j in newly:
                available.remove(j)
            for j in range(n):
                if not placed[j] and i in preds[j]:
                    unplaced_preds[j] += 1
            path.pop()
            placed[i] = False
        return False

    if dfs(model.initial_state(), 0):
        return [ops[i] for i in path]
    return None


def minimal_conflict_prefix(
    ops: Sequence[Operation], model, max_states: int
) -> List[Operation]:
    """Smallest prefix (by start time) of completed ops that already fails."""
    completed = [op for op in ops if not op.pending]
    ordered = sorted(
        completed,
        key=lambda o: (o.start, float("inf") if o.end is None else o.end, str(o.id)),
    )
    for k in range(1, len(ordered) + 1):
        prefix = ordered[:k]
        counter = [0]
        try:
            found = find_linearization(prefix, model, max_states, False, counter)
        except ResourceLimitExceeded:
            break
        if found is None:
            return prefix
    return ordered


def check_history(
    ops: Sequence[Operation], model, max_states: int = 100000
) -> CheckResult:
    counter = [0]
    completed = [op for op in ops if not op.pending]
    pendings = [op for op in ops if op.pending]

    # Phase 1: completed operations only.
    try:
        lin = find_linearization(completed, model, max_states, False, counter)
    except ResourceLimitExceeded:
        return CheckResult(
            Verdict.UNKNOWN_RESOURCE,
            states_explored=counter[0],
            note=f"state budget {max_states} exceeded",
        )
    if lin is not None:
        return CheckResult(
            Verdict.LINEARIZABLE, linearization=lin, states_explored=counter[0]
        )

    # Phase 2: allow pending ops to complete with any legal response.
    if pendings:
        try:
            lin2 = find_linearization(
                completed + pendings, model, max_states, True, counter
            )
        except ResourceLimitExceeded:
            return CheckResult(
                Verdict.UNKNOWN_RESOURCE,
                states_explored=counter[0],
                note=f"state budget {max_states} exceeded",
            )
        if lin2 is not None:
            return CheckResult(
                Verdict.UNKNOWN,
                linearization=lin2,
                states_explored=counter[0],
                note="linearizable only by assuming responses for pending calls",
            )

    prefix = minimal_conflict_prefix(ops, model, max_states)
    return CheckResult(
        Verdict.NON_LINEARIZABLE,
        conflict_prefix=prefix,
        states_explored=counter[0],
        note="no legal linearization exists, even assuming pending responses",
    )
