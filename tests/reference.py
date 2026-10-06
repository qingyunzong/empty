"""Independent reference implementation used to cross-check the store.

Deliberately naive: a from-scratch patch interpreter plus full JSON
traversal for every query and index count. Shares only the scalar
typing primitives (value_key/sort_key/json_equal) with the library.
"""
from __future__ import annotations

import copy

from jsondoc import pointers
from jsondoc.strictjson import json_equal, sort_key, type_name, value_key


class RefPatchError(ValueError):
    pass


def _index(seg, length, allow_end=False):
    if seg == "-":
        if allow_end:
            return length
        raise RefPatchError("dash not allowed here")
    if not seg.isdigit() or (len(seg) > 1 and seg[0] == "0"):
        raise RefPatchError("bad index %r" % seg)
    i = int(seg)
    if i > length or (i == length and not allow_end):
        raise RefPatchError("index out of range")
    return i


def _lookup(node, segments):
    for seg in segments:
        if isinstance(node, dict):
            if seg not in node:
                raise RefPatchError("missing key %r" % seg)
            node = node[seg]
        elif isinstance(node, list):
            node = node[_index(seg, len(node))]
        else:
            raise RefPatchError("through scalar")
    return node


def _add(node, segments, value):
    if not segments:
        return value
    parent = _lookup(node, segments[:-1])
    last = segments[-1]
    if isinstance(parent, dict):
        parent[last] = value
    elif isinstance(parent, list):
        parent.insert(_index(last, len(parent), allow_end=True), value)
    else:
        raise RefPatchError("add into scalar")
    return node


def _remove(node, segments):
    if not segments:
        raise RefPatchError("root removal")
    parent = _lookup(node, segments[:-1])
    last = segments[-1]
    if isinstance(parent, dict):
        if last not in parent:
            raise RefPatchError("missing key %r" % last)
        del parent[last]
    elif isinstance(parent, list):
        del parent[_index(last, len(parent))]
    else:
        raise RefPatchError("remove from scalar")
    return node


def _apply_op(doc, op):
    kind = op["op"]
    if kind == "add":
        return _add(doc, pointers.parse(op["path"]), op["value"])
    if kind == "remove":
        return _remove(doc, pointers.parse(op["path"]))
    if kind == "replace":
        segments = pointers.parse(op["path"])
        _lookup(doc, segments)
        if not segments:
            return op["value"]
        parent = _lookup(doc, segments[:-1])
        if isinstance(parent, dict):
            parent[segments[-1]] = op["value"]
        else:
            parent[_index(segments[-1], len(parent))] = op["value"]
        return doc
    if kind == "move":
        frm = pointers.parse(op["from"])
        dst = pointers.parse(op["path"])
        if len(dst) > len(frm) and dst[: len(frm)] == frm:
            raise RefPatchError("move into own subtree")
        if frm == dst:
            return doc
        value = _lookup(doc, frm)
        return _add(_remove(doc, frm), dst, value)
    if kind == "test":
        if not json_equal(_lookup(doc, pointers.parse(op["path"])), op["value"]):
            raise RefPatchError("test failed")
        return doc
    raise RefPatchError("unknown op %r" % kind)


def ref_apply(doc, ops):
    """Naive all-or-nothing patch interpreter (input never mutated)."""
    new = copy.deepcopy(doc)
    for op in ops:
        new = _apply_op(new, op)
    return new


def ref_extract(doc, pattern):
    """Full traversal returning [(path, value_key)] for a pattern."""
    out = []

    def walk(node, pat, path):
        if not pat:
            if type_name(node) not in ("array", "object"):
                out.append((pointers.format(path), value_key(node)))
            return
        seg = pat[0]
        if seg == "*":
            if isinstance(node, dict):
                for key in node:
                    walk(node[key], pat[1:], path + [key])
            elif isinstance(node, list):
                for i in range(len(node)):
                    walk(node[i], pat[1:], path + [str(i)])
        elif isinstance(node, dict):
            if seg in node:
                walk(node[seg], pat[1:], path + [seg])
        elif isinstance(node, list):
            if seg.isdigit() and int(seg) < len(node):
                walk(node[int(seg)], pat[1:], path + [seg])

    walk(doc, list(pattern), [])
    return out


def _ref_exists(node, segments):
    for seg in segments:
        if isinstance(node, dict):
            if seg not in node:
                return False
            node = node[seg]
        elif isinstance(node, list):
            if not seg.isdigit() or int(seg) >= len(node):
                return False
            node = node[int(seg)]
        else:
            return False
    return True


def ref_query(docs, patterns, query):
    """Full-scan query over a {doc_id: document} mapping."""
    result = None
    for cond in query.get("where", []):
        if "eq" in cond:
            name, value = cond["eq"]
            vk = value_key(value)
            matched = {
                doc_id
                for doc_id, doc in docs.items()
                if any(pair_vk == vk for _, pair_vk in ref_extract(doc, patterns[name]))
            }
        elif "exists" in cond:
            segments = pointers.parse(cond["exists"])
            matched = {
                doc_id
                for doc_id, doc in docs.items()
                if _ref_exists(doc, segments)
            }
        else:
            raise ValueError(cond)
        result = matched if result is None else (result & matched)
    if result is None:
        result = set(docs)
    order = query.get("order_by")
    if order is not None:
        def keyfn(doc_id):
            vks = [vk for _, vk in ref_extract(docs[doc_id], patterns[order])]
            return (0, min(sort_key(vk) for vk in vks)) if vks else (1, None)

        return sorted(result, key=lambda doc_id: (keyfn(doc_id), doc_id))
    return sorted(result)


def ref_index_count(docs, pattern):
    return sum(len(ref_extract(doc, pattern)) for doc in docs.values())
