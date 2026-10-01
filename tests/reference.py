"""Independent reference implementation used to cross-check the store.

Nothing here imports docstore internals: the patch interpreter and the
full-traversal scanner are written from scratch so the acceptance tests
compare two genuinely separate implementations.
"""

import copy


class RefPatchError(Exception):
    pass


def _split(pointer):
    if pointer == "":
        return []
    assert pointer.startswith("/"), pointer
    return [s.replace("~1", "/").replace("~0", "~")
            for s in pointer.split("/")[1:]]


def _resolve(doc, segs):
    node = doc
    for seg in segs:
        if isinstance(node, list):
            node = node[int(seg)]
        elif isinstance(node, dict):
            node = node[seg]
        else:
            raise RefPatchError("through scalar")
    return node


def _strict_eq(a, b):
    if isinstance(a, bool) or isinstance(b, bool):
        return type(a) is type(b) and a == b
    if isinstance(a, (int, float)) and isinstance(b, (int, float)):
        return type(a) is type(b) and a == b
    if isinstance(a, dict) and isinstance(b, dict):
        return a.keys() == b.keys() and all(_strict_eq(a[k], b[k]) for k in a)
    if isinstance(a, list) and isinstance(b, list):
        return len(a) == len(b) and all(_strict_eq(x, y) for x, y in zip(a, b))
    return type(a) is type(b) and a == b


def _add(doc, segs, value):
    if not segs:
        return value
    parent = _resolve(doc, segs[:-1])
    seg = segs[-1]
    if isinstance(parent, list):
        idx = len(parent) if seg == "-" else int(seg)
        if idx > len(parent):
            raise RefPatchError("oob")
        parent.insert(idx, value)
    else:
        parent[seg] = value
    return doc


def _remove(doc, segs):
    parent = _resolve(doc, segs[:-1])
    seg = segs[-1]
    if isinstance(parent, list):
        return parent.pop(int(seg))
    if seg not in parent:
        raise RefPatchError("missing")
    return parent.pop(seg)


def ref_apply(doc, ops):
    """Reference batch interpreter: all-or-nothing on a deep copy."""
    work = copy.deepcopy(doc)
    for op in ops:
        kind = op["op"]
        if kind == "add":
            work = _add(work, _split(op["path"]), copy.deepcopy(op["value"]))
        elif kind == "remove":
            _remove(work, _split(op["path"]))
        elif kind == "replace":
            segs = _split(op["path"])
            _resolve(work, segs)  # must exist
            if not segs:
                work = copy.deepcopy(op["value"])
            else:
                parent = _resolve(work, segs[:-1])
                seg = segs[-1]
                if isinstance(parent, list):
                    parent[int(seg)] = copy.deepcopy(op["value"])
                else:
                    parent[seg] = copy.deepcopy(op["value"])
        elif kind == "move":
            src, dst = _split(op["from"]), _split(op["path"])
            if dst[: len(src)] == src:
                raise RefPatchError("into own subtree")
            value = _remove(work, src)
            work = _add(work, dst, value)
        elif kind == "test":
            if not _strict_eq(_resolve(work, _split(op["path"])), op["value"]):
                raise RefPatchError("test failed")
        else:
            raise RefPatchError("unsupported " + kind)
    return work


def full_scan(doc, pattern):
    """Full independent traversal: pointer-string -> scalar value for every
    path matching the pattern (segments, '*' = wildcard)."""
    pat = _split(pattern)
    out = {}

    def matches(parts):
        if len(parts) != len(pat):
            return False
        return all(p == "*" or p == str(s) for p, s in zip(pat, parts))

    def walk(node, parts):
        if matches(parts) and not isinstance(node, (dict, list)):
            pointer = "".join(
                "/" + str(p).replace("~", "~0").replace("/", "~1")
                for p in parts)
            out[pointer] = node
        if isinstance(node, dict):
            for k, v in node.items():
                walk(v, parts + [k])
        elif isinstance(node, list):
            for i, v in enumerate(node):
                walk(v, parts + [i])

    walk(doc, [])
    return out
