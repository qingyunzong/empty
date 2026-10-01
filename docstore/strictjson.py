"""Strict JSON parsing: duplicate object keys and non-JSON constants
(NaN, Infinity, -Infinity) are rejected."""

import json

from .errors import DuplicateKeyError


def _object_no_dupes(pairs):
    obj = {}
    for key, val in pairs:
        if key in obj:
            raise DuplicateKeyError(f"duplicate object key: {key!r}")
        obj[key] = val
    return obj


def _reject_constant(name):
    raise ValueError(f"invalid JSON constant: {name}")


def loads(text):
    return json.loads(
        text,
        object_pairs_hook=_object_no_dupes,
        parse_constant=_reject_constant,
    )


def dumps(obj, canonical=False):
    if canonical:
        return json.dumps(obj, ensure_ascii=False, sort_keys=True,
                          separators=(",", ":"))
    return json.dumps(obj, ensure_ascii=False)
