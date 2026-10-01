"""Sequential specifications for the supported data types."""

from __future__ import annotations

from typing import Any, Optional, Tuple


class ModelError(ValueError):
    """Raised for unknown implementations or operations."""


_OK = (None, "ok")


class RegisterModel:
    """A single-value register. read() -> value, write(v) -> ok."""

    name = "register"
    read_ops = {"read", "get"}
    write_ops = {"write", "put", "set"}

    def __init__(self, initial: Any = None):
        self.initial = initial

    def initial_state(self) -> Any:
        return self.initial

    def kind(self, op) -> str:
        if op.op in self.read_ops:
            return "read"
        if op.op in self.write_ops:
            return "write"
        raise ModelError(f"unknown register operation: {op.op!r}")

    def step_completed(self, state: Any, op) -> Optional[Any]:
        """Return the next state if the recorded response is legal, else None."""
        kind = self.kind(op)
        if kind == "read":
            return state if op.ret == state else None
        return (op.arg) if op.ret in _OK else None

    def step_pending(self, state: Any, op) -> Any:
        """Apply a pending op assuming some legal response."""
        kind = self.kind(op)
        if kind == "read":
            return state  # may return the current value; state unchanged
        return op.arg


class QueueModel:
    """A FIFO queue. enq(v) -> ok, deq() -> head value or null when empty."""

    name = "queue"
    enq_ops = {"enq", "enqueue", "offer", "push"}
    deq_ops = {"deq", "dequeue", "poll", "pop"}

    def __init__(self, initial: Any = None):
        self.initial = tuple(initial) if initial else ()

    def initial_state(self) -> Tuple:
        return self.initial

    def kind(self, op) -> str:
        if op.op in self.enq_ops:
            return "enq"
        if op.op in self.deq_ops:
            return "deq"
        raise ModelError(f"unknown queue operation: {op.op!r}")

    def step_completed(self, state: Tuple, op) -> Optional[Tuple]:
        kind = self.kind(op)
        if kind == "enq":
            return state + (op.arg,) if op.ret in _OK else None
        # deq
        if not state:
            return state if op.ret in (None, "empty") else None
        if op.ret == state[0]:
            return state[1:]
        return None

    def step_pending(self, state: Tuple, op) -> Tuple:
        kind = self.kind(op)
        if kind == "enq":
            return state + (op.arg,)
        # pending deq: may legally return the head (or null when empty)
        return state[1:] if state else state


_MODELS = {
    "register": RegisterModel,
    "queue": QueueModel,
}


def get_model(name: str, initial: Any = None):
    try:
        cls = _MODELS[name]
    except KeyError:
        raise ModelError(
            f"unknown implementation {name!r}; expected one of {sorted(_MODELS)}"
        ) from None
    if initial is None:
        return cls()
    return cls(initial)
