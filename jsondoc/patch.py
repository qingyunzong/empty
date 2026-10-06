"""RFC 6902 JSON Patch application (all-or-nothing batches)."""
from __future__ import annotations

import copy

from . import pointers
from .strictjson import json_equal

__all__ = ["PatchError", "apply_patch", "affected_roots"]


class PatchError(ValueError):
    """Raised when a patch operation cannot be applied."""


def _require(op, key):
    if key not in op:
        raise PatchError("operation %r misses %r" % (op.get("op"), key))
    return op[key]


def _parse_index(seg, length, allow_end):
    if seg == "-":
        if allow_end:
            return length
        raise PatchError("'-' is only valid as an add target")
    if not seg.isdigit() or (len(seg) > 1 and seg.startswith("0")):
        raise PatchError("invalid array index: %r" % seg)
    idx = int(seg)
    if idx > length or (idx == length and not allow_end):
        raise PatchError("array index out of range: %r" % seg)
    return idx


def _get(node, segments):
    for seg in segments:
        if isinstance(node, dict):
            if seg not in node:
                raise PatchError("missing object key: %r" % seg)
            node = node[seg]
        elif isinstance(node, list):
            node = node[_parse_index(seg, len(node), False)]
        else:
            raise PatchError("cannot traverse into a scalar")
    return node


def _add(node, segments, value):
    if not segments:
        return value
    parent = _get(node, segments[:-1])
    seg = segments[-1]
    if isinstance(parent, dict):
        parent[seg] = value
    elif isinstance(parent, list):
        parent.insert(_parse_index(seg, len(parent), True), value)
    else:
        raise PatchError("cannot add into a scalar")
    return node


def _remove(node, segments):
    if not segments:
        raise PatchError("cannot remove the document root")
    parent = _get(node, segments[:-1])
    seg = segments[-1]
    if isinstance(parent, dict):
        if seg not in parent:
            raise PatchError("missing object key: %r" % seg)
        del parent[seg]
    elif isinstance(parent, list):
        del parent[_parse_index(seg, len(parent), False)]
    else:
        raise PatchError("cannot remove from a scalar")
    return node


def _replace(node, segments, value):
    if not segments:
        return value
    _get(node, segments)  # target must exist
    parent = _get(node, segments[:-1])
    seg = segments[-1]
    if isinstance(parent, dict):
        parent[seg] = value
    else:
        parent[_parse_index(seg, len(parent), False)] = value
    return node


def _apply_op(doc, op):
    if not isinstance(op, dict):
        raise PatchError("operation must be an object")
    kind = op.get("op")
    if kind == "add":
        return _add(doc, pointers.parse(_require(op, "path")), op.get("value"))
    if kind == "remove":
        return _remove(doc, pointers.parse(_require(op, "path")))
    if kind == "replace":
        return _replace(doc, pointers.parse(_require(op, "path")), op.get("value"))
    if kind == "move":
        frm = pointers.parse(_require(op, "from"))
        dst = pointers.parse(_require(op, "path"))
        if len(dst) > len(frm) and dst[: len(frm)] == frm:
            raise PatchError("cannot move a node into its own subtree")
        if frm == dst:
            return doc
        value = _get(doc, frm)
        doc = _remove(doc, frm)
        return _add(doc, dst, value)
    if kind == "test":
        if not json_equal(_get(doc, pointers.parse(_require(op, "path"))), op.get("value")):
            raise PatchError("test operation failed")
        return doc
    raise PatchError("unknown operation: %r" % (kind,))


def apply_patch(doc, ops):
    """Apply a patch batch to ``doc``; the input is never mutated.

    Returns the patched document. Raises :class:`PatchError` if any
    operation fails, in which case nothing is applied (all-or-nothing).
    """
    if not isinstance(ops, list):
        raise PatchError("a patch must be a list of operations")
    new = copy.deepcopy(doc)
    for op in ops:
        new = _apply_op(new, op)
    return new


def affected_roots(ops):
    """Compute the minimal set of subtree roots a patch batch touches.

    Used for incremental index maintenance: add/remove affect their
    parent (array inserts/removals shift sibling indices), replace
    affects its own subtree, move affects both parents.
    """
    roots = []
    for op in ops:
        if not isinstance(op, dict):
            raise PatchError("operation must be an object")
        kind = op.get("op")
        if kind in ("add", "remove"):
            segs = pointers.parse(_require(op, "path"))
            roots.append(pointers.format(segs[:-1]))
        elif kind == "replace":
            segs = pointers.parse(_require(op, "path"))
            roots.append(pointers.format(segs))
        elif kind == "move":
            frm = pointers.parse(_require(op, "from"))
            dst = pointers.parse(_require(op, "path"))
            roots.append(pointers.format(frm[:-1]))
            roots.append(pointers.format(dst[:-1]))
        elif kind == "test":
            continue
        else:
            raise PatchError("unknown operation: %r" % (kind,))
    unique = []
    for root in roots:
        if root not in unique:
            unique.append(root)
    return [
        root
        for root in unique
        if not any(other != root and pointers.is_prefix(other, root) for other in unique)
    ]
