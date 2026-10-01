"""Parsing and validation of concurrent history JSON files."""

from __future__ import annotations

import json
from typing import List

from .solver import Op

SUPPORTED_TYPES = ("stack",)


class HistoryError(Exception):
    """Raised when a history file is malformed or semantically invalid."""


def _is_number(value) -> bool:
    return isinstance(value, (int, float)) and not isinstance(value, bool)


def _parse_op(index: int, raw) -> Op:
    if not isinstance(raw, dict):
        raise HistoryError(f"operations[{index}] must be an object")
    op_id = raw.get("id")
    if not isinstance(op_id, str) or not op_id:
        raise HistoryError(f"operations[{index}].id must be a non-empty string")
    kind = raw.get("op")
    if kind not in ("push", "pop"):
        raise HistoryError(f"operation {op_id!r}: op must be 'push' or 'pop'")
    call = raw.get("call")
    if not _is_number(call):
        raise HistoryError(f"operation {op_id!r}: call must be a number")
    ret = raw.get("return")
    if ret is not None:
        if not _is_number(ret):
            raise HistoryError(f"operation {op_id!r}: return must be a number or null")
        if ret < call:
            raise HistoryError(f"operation {op_id!r}: return precedes call")
    arg = raw.get("arg")
    if kind == "push" and "arg" not in raw:
        raise HistoryError(f"operation {op_id!r}: push requires 'arg'")
    result = raw.get("result")
    if kind == "pop" and ret is not None and "result" not in raw:
        raise HistoryError(f"operation {op_id!r}: completed pop requires 'result'")
    return Op(id=op_id, kind=kind, arg=arg, result=result, call=call, ret=ret)


def load_history(text: str, expected_type: str = "stack") -> List[Op]:
    """Parse history JSON text into a list of Op, raising HistoryError if invalid."""
    try:
        data = json.loads(text)
    except json.JSONDecodeError as exc:
        raise HistoryError(f"invalid JSON: {exc}") from exc
    if not isinstance(data, dict):
        raise HistoryError("top-level value must be an object")
    hist_type = data.get("type", "stack")
    if hist_type != expected_type:
        raise HistoryError(f"unsupported history type {hist_type!r}")
    raw_ops = data.get("operations")
    if not isinstance(raw_ops, list):
        raise HistoryError("'operations' must be a list")
    ops = [_parse_op(i, raw) for i, raw in enumerate(raw_ops)]
    seen = set()
    for op in ops:
        if op.id in seen:
            raise HistoryError(f"duplicate operation id {op.id!r}")
        seen.add(op.id)
    return ops
