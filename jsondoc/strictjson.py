"""Strict JSON loading/dumping with lexical number typing.

Rules enforced here:
- Integers and decimals are distinct lexical types: ``1`` parses to
  ``int`` while ``1.0`` / ``1e2`` parse to ``decimal.Decimal``.
- Booleans are never treated as integers (``True`` is an ``int``
  subclass in Python, so checks are ordered carefully).
- Duplicate object keys are rejected.
- Non-JSON constants (NaN, Infinity, ...) are rejected.
"""
from __future__ import annotations

import json
from decimal import Decimal

__all__ = [
    "StrictJSONError",
    "DuplicateKeyError",
    "loads",
    "dumps",
    "type_name",
    "value_key",
    "sort_key",
    "json_equal",
]


class StrictJSONError(ValueError):
    """Base error for strict JSON violations."""


class DuplicateKeyError(StrictJSONError):
    """Raised when an object literal repeats a key."""


def _reject_constant(name):
    raise StrictJSONError("non-JSON constant: %s" % name)


def _object_no_duplicates(pairs):
    obj = {}
    for key, value in pairs:
        if key in obj:
            raise DuplicateKeyError("duplicate object key: %r" % key)
        obj[key] = value
    return obj


def loads(text):
    """Parse JSON text enforcing strict typing rules."""
    if isinstance(text, (bytes, bytearray)):
        text = text.decode("utf-8")
    return json.loads(
        text,
        parse_int=int,
        parse_float=Decimal,
        parse_constant=_reject_constant,
        object_pairs_hook=_object_no_duplicates,
    )


def dumps(value):
    """Serialize a value parsed by :func:`loads` back to JSON text."""
    parts = []
    _emit(value, parts)
    return "".join(parts)


def _emit(value, parts):
    if value is None:
        parts.append("null")
    elif isinstance(value, bool):
        parts.append("true" if value else "false")
    elif isinstance(value, int):
        parts.append(str(value))
    elif isinstance(value, Decimal):
        parts.append(str(value))
    elif isinstance(value, str):
        parts.append(json.dumps(value, ensure_ascii=False))
    elif isinstance(value, list):
        parts.append("[")
        for i, item in enumerate(value):
            if i:
                parts.append(",")
            _emit(item, parts)
        parts.append("]")
    elif isinstance(value, dict):
        parts.append("{")
        for i, (key, item) in enumerate(value.items()):
            if not isinstance(key, str):
                raise StrictJSONError("object keys must be strings")
            if i:
                parts.append(",")
            parts.append(json.dumps(key, ensure_ascii=False))
            parts.append(":")
            _emit(item, parts)
        parts.append("}")
    else:
        raise StrictJSONError("unsupported value type: %s" % type(value).__name__)


def type_name(value):
    if value is None:
        return "null"
    if isinstance(value, bool):
        return "boolean"
    if isinstance(value, int):
        return "integer"
    if isinstance(value, Decimal):
        return "decimal"
    if isinstance(value, str):
        return "string"
    if isinstance(value, list):
        return "array"
    if isinstance(value, dict):
        return "object"
    raise StrictJSONError("unsupported value type: %s" % type(value).__name__)


def value_key(value):
    """Hashable, type-tagged key for a scalar JSON value.

    Integers and decimals never share a key; booleans never share a
    key with integers.
    """
    tag = type_name(value)
    if tag == "null":
        return ("null",)
    if tag in ("array", "object"):
        raise StrictJSONError("containers have no scalar value key")
    return (tag, value)


def sort_key(vk):
    """Total ordering over value keys.

    Order: null < false < true < numbers (int before decimal on ties)
    < strings.
    """
    tag = vk[0]
    if tag == "null":
        return (0, 0, 0)
    if tag == "boolean":
        return (1, vk[1], 0)
    if tag == "integer":
        return (2, vk[1], 0)
    if tag == "decimal":
        return (2, vk[1], 1)
    return (3, vk[1], 0)


def json_equal(a, b):
    """Type-aware JSON equality (``1`` != ``1.0`` != ``True``)."""
    ta = type_name(a)
    if ta != type_name(b):
        return False
    if ta == "array":
        return len(a) == len(b) and all(json_equal(x, y) for x, y in zip(a, b))
    if ta == "object":
        return a.keys() == b.keys() and all(json_equal(a[k], b[k]) for k in a)
    return a == b
