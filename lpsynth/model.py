"""History data model and input validation for lpsynth."""
from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Optional

#: Reserved pop return value denoting a pop observed on an empty stack.
EMPTY = "EMPTY"

SUPPORTED_TYPES = ("stack",)


class HistoryError(ValueError):
    """Raised when the input history is malformed."""


@dataclass
class Operation:
    """A single operation in a concurrent history.

    ``end is None`` means the operation is pending (called, never returned).
    For a push, ``value`` is the pushed value. For a completed pop, ``value``
    is the observed return value (``EMPTY`` for an empty pop). For a pending
    pop, ``value`` may be None (unknown) or a hypothesized return value.
    """

    id: str
    kind: str  # "push" | "pop"
    value: Any
    start: float
    end: Optional[float]

    @property
    def pending(self) -> bool:
        return self.end is None


def _is_number(x: Any) -> bool:
    return isinstance(x, (int, float)) and not isinstance(x, bool)


def parse_history(data: Any) -> list[Operation]:
    """Validate a decoded JSON history and return its operations."""
    if not isinstance(data, dict):
        raise HistoryError("history must be a JSON object")
    htype = data.get("type", "stack")
    if htype not in SUPPORTED_TYPES:
        raise HistoryError(f"unsupported history type: {htype!r}")
    raw_ops = data.get("operations")
    if not isinstance(raw_ops, list):
        raise HistoryError('"operations" must be a list')

    ops: list[Operation] = []
    seen: set[str] = set()
    for index, raw in enumerate(raw_ops):
        where = f"operations[{index}]"
        if not isinstance(raw, dict):
            raise HistoryError(f"{where} must be an object")

        op_id = raw.get("id")
        if not isinstance(op_id, (str, int)) or isinstance(op_id, bool):
            raise HistoryError(f"{where}.id must be a string or integer")
        op_id = str(op_id)
        if op_id in seen:
            raise HistoryError(f"duplicate operation id: {op_id!r}")
        seen.add(op_id)

        kind = raw.get("op")
        if kind not in ("push", "pop"):
            raise HistoryError(f"{where}.op must be 'push' or 'pop'")

        start = raw.get("start")
        if not _is_number(start):
            raise HistoryError(f"{where}.start must be a number")

        end = raw.get("end")
        if end is not None:
            if not _is_number(end):
                raise HistoryError(f"{where}.end must be a number or null")
            if end < start:
                raise HistoryError(f"{where}.end must be >= start")

        has_value = "value" in raw
        value = raw.get("value")
        if kind == "push":
            if not has_value:
                raise HistoryError(f"{where}: push requires a value")
            if value == EMPTY:
                raise HistoryError(f"{where}: {EMPTY!r} is reserved for pop returns")
        else:  # pop
            if end is not None and not has_value:
                raise HistoryError(f"{where}: completed pop requires a return value")

        ops.append(Operation(id=op_id, kind=kind, value=value, start=start, end=end))
    return ops
