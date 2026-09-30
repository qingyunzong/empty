"""Recursive three-way merge of JSON-compatible values.

Missing object keys / out-of-range array indices are treated as null,
both during comparison and in the merged output.
"""

MISSING = object()


def _escape(segment):
    return str(segment).replace("~", "~0").replace("/", "~1")


def pointer_of(path):
    """Render a path tuple as a JSON Pointer (RFC 6901)."""
    if not path:
        return ""
    return "/" + "/".join(_escape(part) for part in path)


def _norm(value):
    return None if value is MISSING else value


def merge3(base, ours, theirs, path=(), conflicts=None):
    """Merge ``ours`` and ``theirs`` relative to ``base``.

    Returns the merged value. Conflict paths (as tuples) are appended to
    ``conflicts``; on conflict the ``ours`` value is kept in the result.
    """
    if conflicts is None:
        conflicts = []
    b = _norm(base)
    o = _norm(ours)
    t = _norm(theirs)

    # Recurse into matching containers first so that keys/indices missing
    # on a changed side are uniformly recorded as null in the output.
    if isinstance(o, dict) and isinstance(t, dict):
        keys = list(o.keys())
        keys += [k for k in t if k not in o]
        if isinstance(b, dict):
            keys += [k for k in b if k not in o and k not in t]
        return {
            k: merge3(
                b.get(k, MISSING) if isinstance(b, dict) else MISSING,
                o.get(k, MISSING),
                t.get(k, MISSING),
                path + (k,),
                conflicts,
            )
            for k in keys
        }

    if isinstance(o, list) and isinstance(t, list):
        size = max(
            len(b) if isinstance(b, list) else 0,
            len(o),
            len(t),
        )
        return [
            merge3(
                b[i] if isinstance(b, list) and i < len(b) else MISSING,
                o[i] if i < len(o) else MISSING,
                t[i] if i < len(t) else MISSING,
                path + (i,),
                conflicts,
            )
            for i in range(size)
        ]

    if o == t:  # both unchanged, or both made the same change
        return o
    if b == o:  # only theirs changed
        return t
    if b == t:  # only ours changed
        return o

    conflicts.append(path)
    return o
