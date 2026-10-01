"""Parsing and validation of concurrent histories.

Two input shapes are supported:

1. A list of operation records, one per operation::

       {"id": 1, "thread": "A", "op": "write", "arg": 1,
        "ret": null, "start": 0, "end": 3}

   ``end: null`` (or a missing ``end``) marks a *pending* operation: its
   call was issued but no response was observed.

2. A list of call/return events matched by ``(thread, id)``::

       {"type": "call",   "id": 1, "thread": "A", "op": "write",
        "arg": 1, "time": 0}
       {"type": "return", "id": 1, "thread": "A", "ret": null, "time": 3}

The top level may also be an object ``{"events": [...], "initial": V}``
where ``initial`` optionally overrides the model's initial state.
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from typing import Any, Optional


class HistoryError(ValueError):
    """Raised when the input history is malformed."""


@dataclass(frozen=True)
class Operation:
    index: int
    id: Any
    thread: str
    op: str
    arg: Any
    ret: Any
    start: float
    end: Optional[float]  # None => pending (no response observed)

    @property
    def pending(self) -> bool:
        return self.end is None

    def describe(self) -> str:
        arg = "" if self.arg is None else repr(self.arg)
        ret = "?" if self.pending else repr(self.ret)
        return (
            f"id={self.id} thread={self.thread} {self.op}({arg}) -> {ret} "
            f"[{self.start}, {'inf' if self.pending else self.end}]"
        )


def _is_number(x: Any) -> bool:
    return isinstance(x, (int, float)) and not isinstance(x, bool)


def _load_json(text: str) -> Any:
    try:
        data = json.loads(text)
    except json.JSONDecodeError as exc:
        raise HistoryError(f"invalid JSON: {exc}") from exc
    return data


def load_history_text(text: str):
    """Parse history text. Returns (operations, initial_or_None)."""
    data = _load_json(text)
    initial = None
    has_initial = False
    events = data
    if isinstance(data, dict):
        if "events" not in data:
            raise HistoryError("top-level object must contain an 'events' list")
        events = data["events"]
        if "initial" in data:
            initial = data["initial"]
            has_initial = True
    if not isinstance(events, list):
        raise HistoryError("history must be a list of events")
    ops = _normalize(events)
    return ops, (initial if has_initial else None)


def _normalize(events: list) -> list:
    if all(isinstance(e, dict) and "start" in e for e in events):
        return _from_op_records(events)
    if all(isinstance(e, dict) and e.get("type") in ("call", "return") for e in events):
        return _from_call_return(events)
    raise HistoryError(
        "events must be either all operation records (with 'start') "
        "or all call/return events (with 'type')"
    )


def _check_common(idx: int, rec: dict) -> None:
    if "op" not in rec or not isinstance(rec["op"], str):
        raise HistoryError(f"event {idx}: missing or invalid 'op' (string required)")
    if "thread" not in rec or not isinstance(rec["thread"], str):
        raise HistoryError(f"event {idx}: missing or invalid 'thread' (string required)")


def _from_op_records(events: list) -> list:
    ops = []
    for idx, rec in enumerate(events):
        _check_common(idx, rec)
        start = rec.get("start")
        if not _is_number(start):
            raise HistoryError(f"event {idx}: 'start' must be a number")
        end = rec.get("end", None)
        if end is not None and not _is_number(end):
            raise HistoryError(f"event {idx}: 'end' must be a number or null")
        if end is not None and end < start:
            raise HistoryError(f"event {idx}: 'end' < 'start'")
        ops.append(
            Operation(
                index=idx,
                id=rec.get("id", idx),
                thread=rec["thread"],
                op=rec["op"],
                arg=rec.get("arg"),
                ret=rec.get("ret"),
                start=float(start),
                end=None if end is None else float(end),
            )
        )
    return ops


def _from_call_return(events: list) -> list:
    calls: dict = {}
    returns: dict = {}
    for idx, rec in enumerate(events):
        key = (rec.get("thread"), rec.get("id"))
        if key[0] is None or key[1] is None:
            raise HistoryError(f"event {idx}: call/return events need 'thread' and 'id'")
        if not _is_number(rec.get("time")):
            raise HistoryError(f"event {idx}: 'time' must be a number")
        bucket = calls if rec["type"] == "call" else returns
        if key in bucket:
            raise HistoryError(f"event {idx}: duplicate {rec['type']} for {key}")
        bucket[key] = rec
    for key in returns:
        if key not in calls:
            raise HistoryError(f"return without matching call for {key}")
    ops = []
    for idx, (key, call) in enumerate(sorted(calls.items(), key=lambda kv: kv[1]["time"])):
        _check_common(idx, call)
        ret_ev = returns.get(key)
        start = float(call["time"])
        end = None if ret_ev is None else float(ret_ev["time"])
        if end is not None and end < start:
            raise HistoryError(f"event for {key}: return time < call time")
        ops.append(
            Operation(
                index=idx,
                id=key[1],
                thread=key[0],
                op=call["op"],
                arg=call.get("arg"),
                ret=None if ret_ev is None else ret_ev.get("ret"),
                start=start,
                end=end,
            )
        )
    return ops
