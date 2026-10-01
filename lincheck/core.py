"""Linearizability checker for concurrent histories (register / queue)."""
from __future__ import annotations

import json
from dataclasses import dataclass, field
from enum import Enum
from typing import Any, Optional


class InvalidHistory(Exception):
    """Raised when the input history is malformed."""


class ResourceLimitExceeded(Exception):
    """Raised when the explored-state budget is exhausted."""


class Verdict(str, Enum):
    LINEARIZABLE = "LINEARIZABLE"
    NON_LINEARIZABLE = "NON_LINEARIZABLE"
    UNKNOWN = "UNKNOWN"
    UNKNOWN_RESOURCE = "UNKNOWN_RESOURCE"


# ---------------------------------------------------------------------------
# Operations
# ---------------------------------------------------------------------------

_OP_ALIASES = {
    "read": "read", "get": "read",
    "write": "write", "set": "write",
    "enqueue": "enqueue", "enq": "enqueue", "push": "enqueue",
    "dequeue": "dequeue", "deq": "dequeue", "pop": "dequeue",
}

_IMPL_OPS = {
    "register": {"read", "write"},
    "queue": {"enqueue", "dequeue"},
}

# Ops whose return value is a pure acknowledgement (never constrains the check).
_ACK_OPS = {"write", "enqueue"}


@dataclass
class Op:
    id: Any
    thread: Any
    op: str
    arg: Any
    ret: Any
    start: float
    end: Optional[float]  # None => pending (no matching return event)

    @property
    def pending(self) -> bool:
        return self.end is None


# ---------------------------------------------------------------------------
# Object models
# ---------------------------------------------------------------------------

class RegisterModel:
    def __init__(self, initial: Any = 0):
        self.initial = initial

    def init_state(self) -> Any:
        return self.initial

    def step(self, state: Any, op: Op):
        """Yield (new_state, return_value) for every legal transition."""
        if op.op == "read":
            yield state, state
        else:  # write
            yield op.arg, None


class QueueModel:
    def __init__(self, initial: Any = None):
        self.initial = tuple(initial or ())

    def init_state(self) -> Any:
        return self.initial

    def step(self, state: tuple, op: Op):
        if op.op == "enqueue":
            yield state + (op.arg,), None
        else:  # dequeue; empty dequeue is reported as ret=None
            if state:
                yield state[1:], state[0]
            else:
                yield state, None


def make_model(impl: str, initial: Any = None):
    if impl == "register":
        return RegisterModel(0 if initial is None else initial)
    if impl == "queue":
        return QueueModel(initial)
    raise InvalidHistory(f"unknown impl: {impl!r}")


# ---------------------------------------------------------------------------
# Parsing / validation
# ---------------------------------------------------------------------------

def _num(value: Any, what: str) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise InvalidHistory(f"{what} must be a number, got {value!r}")
    return value


def _normalize_op_name(name: Any, impl: str) -> str:
    if not isinstance(name, str):
        raise InvalidHistory(f"op name must be a string, got {name!r}")
    canon = _OP_ALIASES.get(name.lower())
    if canon is None or canon not in _IMPL_OPS[impl]:
        raise InvalidHistory(f"unknown op {name!r} for impl {impl!r}")
    return canon


def _op_from_record(rec: Any, impl: str, index: int) -> Op:
    if not isinstance(rec, dict):
        raise InvalidHistory(f"operation #{index} must be an object")
    if "op" not in rec:
        raise InvalidHistory(f"operation #{index} is missing 'op'")
    if "start" not in rec:
        raise InvalidHistory(f"operation #{index} is missing 'start'")
    start = _num(rec["start"], f"operation #{index} 'start'")
    end = rec.get("end")
    if end is not None:
        end = _num(end, f"operation #{index} 'end'")
        if end < start:
            raise InvalidHistory(
                f"operation #{index}: end ({end}) precedes start ({start})")
    return Op(
        id=rec.get("id", index),
        thread=rec.get("thread"),
        op=_normalize_op_name(rec["op"], impl),
        arg=rec.get("arg"),
        ret=rec.get("ret"),
        start=start,
        end=end,
    )


def _ops_from_events(events: Any, impl: str) -> list[Op]:
    if not isinstance(events, list):
        raise InvalidHistory("'events' must be a list")
    calls: dict[tuple, dict] = {}
    returns: dict[tuple, dict] = {}
    for i, ev in enumerate(events):
        if not isinstance(ev, dict):
            raise InvalidHistory(f"event #{i} must be an object")
        etype = ev.get("type", ev.get("kind"))
        if not isinstance(etype, str):
            raise InvalidHistory(f"event #{i} is missing 'type'")
        etype = etype.lower()
        key = (ev.get("thread"), ev.get("id"))
        if key[1] is None:
            raise InvalidHistory(f"event #{i} is missing 'id'")
        if etype in ("call", "invoke", "invocation"):
            if key in calls:
                raise InvalidHistory(f"duplicate call event for {key!r}")
            calls[key] = ev
        elif etype in ("return", "response", "ret"):
            if key in returns:
                raise InvalidHistory(f"duplicate return event for {key!r}")
            returns[key] = ev
        else:
            raise InvalidHistory(f"event #{i} has unknown type {etype!r}")
    ops: list[Op] = []
    for key, call in calls.items():
        ret_ev = returns.pop(key, None)
        start = _num(call.get("time", call.get("start")),
                     f"call event {key!r} time")
        end = None
        ret = None
        if ret_ev is not None:
            end = _num(ret_ev.get("time", ret_ev.get("end")),
                       f"return event {key!r} time")
            if end < start:
                raise InvalidHistory(
                    f"event {key!r}: return time precedes call time")
            ret = ret_ev.get("ret")
        ops.append(Op(
            id=call.get("id"),
            thread=call.get("thread"),
            op=_normalize_op_name(call.get("op"), impl),
            arg=call.get("arg"),
            ret=ret,
            start=start,
            end=end,
        ))
    if returns:
        raise InvalidHistory(
            f"return events without matching call: {sorted(map(str, returns))}")
    return ops


def parse_history(data: Any, impl: str) -> tuple[list[Op], Any]:
    """Parse decoded JSON into (operations, initial_value)."""
    if impl not in _IMPL_OPS:
        raise InvalidHistory(f"unknown impl: {impl!r}")
    initial = None
    if isinstance(data, list):
        records = data
        ops = [_op_from_record(r, impl, i) for i, r in enumerate(records)]
    elif isinstance(data, dict):
        initial = data.get("initial")
        if "operations" in data:
            records = data["operations"]
            if not isinstance(records, list):
                raise InvalidHistory("'operations' must be a list")
            ops = [_op_from_record(r, impl, i) for i, r in enumerate(records)]
        elif "events" in data:
            ops = _ops_from_events(data["events"], impl)
        else:
            raise InvalidHistory(
                "history object must contain 'operations' or 'events'")
    else:
        raise InvalidHistory("history must be a list or an object")
    ids = [op.id for op in ops]
    if len(set(map(lambda x: json.dumps(x, sort_keys=True, default=str), ids))) != len(ids):
        raise InvalidHistory("duplicate operation ids")
    return ops, initial


# ---------------------------------------------------------------------------
# Backtracking checker with memoization pruning
# ---------------------------------------------------------------------------

class _Budget:
    def __init__(self, max_states: int):
        self.max_states = max_states
        self.states = 0

    def tick(self) -> None:
        self.states += 1
        if self.states > self.max_states:
            raise ResourceLimitExceeded


def _state_key(state: Any) -> str:
    return json.dumps(state, sort_keys=True, default=str)


def _ret_matches(op: Op, expected: Any) -> bool:
    if op.op in _ACK_OPS:
        return True
    return op.ret == expected


def check(ops: list[Op], model, max_states: int,
          budget: Optional[_Budget] = None) -> Optional[list[int]]:
    """Return a linearization (list of op indices) or None.

    Completed operations must produce their recorded return; pending
    operations may take any legal transition (any legal return).
    """
    n = len(ops)
    pred = [0] * n
    for i in range(n):
        for j in range(n):
            if i != j and ops[j].end is not None and ops[j].end <= ops[i].start:
                pred[i] |= 1 << j

    if budget is None:
        budget = _Budget(max_states)
    visited: set[tuple[int, str]] = set()
    init = model.init_state()

    def dfs(remaining: int, state: Any, lin: list[int]) -> Optional[list[int]]:
        budget.tick()
        if remaining == 0:
            return list(lin)
        key = (remaining, _state_key(state))
        if key in visited:
            return None
        visited.add(key)
        for i in range(n):
            bit = 1 << i
            if not remaining & bit or pred[i] & remaining:
                continue
            op = ops[i]
            for new_state, ret in model.step(state, op):
                if not op.pending and not _ret_matches(op, ret):
                    continue
                lin.append(i)
                found = dfs(remaining & ~bit, new_state, lin)
                if found is not None:
                    return found
                lin.pop()
        return None

    return dfs((1 << n) - 1, init, [])


def minimal_conflict_prefix(ops: list[Op], model, max_states: int) -> list[Any]:
    """Smallest prefix (ops ordered by start time) that is non-linearizable."""
    order = sorted(range(len(ops)), key=lambda i: (ops[i].start, str(ops[i].id)))
    for k in range(1, len(ops) + 1):
        sub = [ops[i] for i in order[:k]]
        try:
            if check(sub, model, max_states) is None:
                return [ops[i].id for i in order[:k]]
        except ResourceLimitExceeded:
            break
    return [op.id for op in ops]


# ---------------------------------------------------------------------------
# Top-level verification
# ---------------------------------------------------------------------------

@dataclass
class Result:
    verdict: Verdict
    states: int = 0
    linearization: Optional[list[dict]] = None
    conflict_prefix: Optional[list[Any]] = None

    def to_dict(self) -> dict:
        out: dict[str, Any] = {"verdict": self.verdict.value, "states": self.states}
        if self.linearization is not None:
            out["linearization"] = self.linearization
        if self.conflict_prefix is not None:
            out["conflict_prefix"] = self.conflict_prefix
        return out


def verify(ops: list[Op], impl: str, max_states: int = 100_000,
           initial: Any = None) -> Result:
    if max_states <= 0:
        raise InvalidHistory("max-states must be a positive integer")
    model = make_model(impl, initial)
    budget = _Budget(max_states)
    try:
        lin = check(ops, model, max_states, budget)
    except ResourceLimitExceeded:
        return Result(Verdict.UNKNOWN_RESOURCE, states=budget.states)
    if lin is not None:
        points = [
            {
                "point": position,
                "id": ops[idx].id,
                "thread": ops[idx].thread,
                "op": ops[idx].op,
                "arg": ops[idx].arg,
                "pending": ops[idx].pending,
            }
            for position, idx in enumerate(lin)
        ]
        return Result(Verdict.LINEARIZABLE, states=budget.states,
                      linearization=points)
    if any(op.pending for op in ops):
        # Failure cannot be attributed solely to the implementation: pending
        # calls have unobserved returns, so the verdict stays undecided.
        return Result(Verdict.UNKNOWN, states=budget.states)
    prefix = minimal_conflict_prefix(ops, model, max_states)
    return Result(Verdict.NON_LINEARIZABLE, states=budget.states,
                  conflict_prefix=prefix)
