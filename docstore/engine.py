"""JSON Patch (RFC 6902 style) engine.

Supports add / remove / replace / move / test / copy.  Every operation
reports the *affected prefixes* of the document so callers can maintain
indexes incrementally instead of rebuilding them:

* removal prefixes  -- typed path prefixes whose index entries must be
  dropped, evaluated against the pre-operation document;
* addition prefixes -- typed path prefixes to re-scan for index entries,
  evaluated against the post-operation document.

Array insertions/removals report the whole array as affected, which
captures the index shift of every following sibling.  Object key and
in-place replacements report only the touched subtree.
"""

from copy import deepcopy

from .errors import PatchError
from .paths import parse_pointer
from .values import json_equal


class Affected:
    __slots__ = ("removals", "additions")

    def __init__(self, removals=(), additions=()):
        self.removals = list(removals)
        self.additions = list(additions)

    def extend(self, other):
        self.removals.extend(other.removals)
        self.additions.extend(other.additions)


def _as_index(seg, length, allow_end=False):
    if seg == "-":
        if allow_end:
            return length
        raise PatchError("'-' is only valid for array add")
    try:
        idx = int(seg)
    except (TypeError, ValueError):
        raise PatchError(f"invalid array index: {seg!r}") from None
    if str(idx) != seg and not (seg.isdigit() and idx >= 0):
        raise PatchError(f"invalid array index: {seg!r}")
    upper = length if allow_end else length - 1
    if idx < 0 or idx > upper:
        raise PatchError(f"array index out of range: {seg!r}")
    return idx


def _walk(doc, path):
    """Walk ``path`` (raw string segments); return (node, typed_path)."""
    node = doc
    typed = []
    for seg in path:
        if isinstance(node, list):
            idx = _as_index(seg, len(node))
            typed.append(idx)
            node = node[idx]
        elif isinstance(node, dict):
            if seg not in node:
                raise PatchError(f"missing object key: {seg!r}")
            typed.append(seg)
            node = node[seg]
        else:
            raise PatchError(f"cannot descend into scalar at {seg!r}")
    return node, tuple(typed)


def _parent(doc, path):
    if not path:
        raise PatchError("operation needs a parent but path is root")
    parent, typed = _walk(doc, path[:-1])
    return parent, typed, path[-1]


def get_value(doc, pointer):
    node, _ = _walk(doc, parse_pointer(pointer))
    return node


def _op_add(doc, op):
    path = parse_pointer(op.get("path", ""))
    if "value" not in op:
        raise PatchError("add requires 'value'")
    value = deepcopy(op["value"])
    if not path:
        return value, Affected([()], [()])
    parent, typed, seg = _parent(doc, path)
    if isinstance(parent, list):
        idx = _as_index(seg, len(parent), allow_end=True)
        parent.insert(idx, value)
        # insertion shifts every following sibling: reindex the whole array
        return doc, Affected([typed], [typed])
    if not isinstance(parent, dict):
        raise PatchError("add target parent is not a container")
    parent[seg] = value
    full = typed + (seg,)
    return doc, Affected([full], [full])


def _remove_at(doc, path):
    parent, typed, seg = _parent(doc, path)
    if isinstance(parent, list):
        idx = _as_index(seg, len(parent))
        removed = parent.pop(idx)
        # removal shifts every following sibling
        return removed, Affected([typed], [typed])
    if not isinstance(parent, dict):
        raise PatchError("remove target parent is not a container")
    if seg not in parent:
        raise PatchError(f"missing object key: {seg!r}")
    removed = parent[seg]
    del parent[seg]
    return removed, Affected([typed + (seg,)], [])


def _op_remove(doc, op):
    path = parse_pointer(op.get("path", ""))
    if not path:
        raise PatchError("cannot remove the document root")
    _, aff = _remove_at(doc, path)
    return doc, aff


def _op_replace(doc, op):
    path = parse_pointer(op.get("path", ""))
    if "value" not in op:
        raise PatchError("replace requires 'value'")
    value = deepcopy(op["value"])
    if not path:
        return value, Affected([()], [()])
    parent, typed, seg = _parent(doc, path)
    if isinstance(parent, list):
        idx = _as_index(seg, len(parent))
        parent[idx] = value
        full = typed + (idx,)
        return doc, Affected([full], [full])
    if not isinstance(parent, dict):
        raise PatchError("replace target parent is not a container")
    if seg not in parent:
        raise PatchError(f"missing object key: {seg!r}")
    parent[seg] = value
    full = typed + (seg,)
    return doc, Affected([full], [full])


def _add_value(doc, path, value):
    if not path:
        return value, Affected([()], [()])
    parent, typed, seg = _parent(doc, path)
    if isinstance(parent, list):
        idx = _as_index(seg, len(parent), allow_end=True)
        parent.insert(idx, value)
        return doc, Affected([typed], [typed])
    if not isinstance(parent, dict):
        raise PatchError("add target parent is not a container")
    parent[seg] = value
    full = typed + (seg,)
    return doc, Affected([full], [full])


def _op_move(doc, op):
    src = parse_pointer(op.get("from", ""))
    dst = parse_pointer(op.get("path", ""))
    if not src:
        raise PatchError("cannot move the document root")
    if not dst:
        raise PatchError("cannot move a value over the document root")
    if dst[: len(src)] == src:
        raise PatchError(
            "cannot move a node into itself or its own subtree: "
            f"{op.get('from')!r} -> {op.get('path')!r}"
        )
    # validate source exists before mutating anything
    _walk(doc, src)
    value, aff = _remove_at(doc, src)
    combined = Affected(aff.removals, aff.additions)
    try:
        doc, aff2 = _add_value(doc, dst, value)
    except Exception:
        # best-effort restore so a failed batch leaves the working copy sane
        _add_value(doc, src, value)
        raise
    combined.extend(aff2)
    return doc, combined


def _op_copy(doc, op):
    src = parse_pointer(op.get("from", ""))
    dst = parse_pointer(op.get("path", ""))
    value, _ = _walk(doc, src)
    return _add_value(doc, dst, deepcopy(value))


def _op_test(doc, op):
    path = parse_pointer(op.get("path", ""))
    if "value" not in op:
        raise PatchError("test requires 'value'")
    node, _ = _walk(doc, path)
    if not json_equal(node, op["value"]):
        raise PatchError(f"test operation failed at {op.get('path')!r}")
    return doc, Affected()


_OPS = {
    "add": _op_add,
    "remove": _op_remove,
    "replace": _op_replace,
    "move": _op_move,
    "copy": _op_copy,
    "test": _op_test,
}


def apply_op(doc, op):
    """Apply a single operation; returns (document, Affected).

    The returned document is the same object unless a root replacement
    swapped it for a new one.
    """
    if not isinstance(op, dict) or "op" not in op:
        raise PatchError(f"malformed operation: {op!r}")
    handler = _OPS.get(op["op"])
    if handler is None:
        raise PatchError(f"unsupported operation: {op['op']!r}")
    return handler(doc, op)
