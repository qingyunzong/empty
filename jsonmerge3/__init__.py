"""Three-way recursive JSON merge.

Public API:
    merge3(base, ours, theirs) -> (merged, conflicts)

``merged`` is the merged JSON value. ``conflicts`` is a list of
RFC 6901 JSON Pointer strings, in document order, for every location
where both sides changed the same value in different ways.

Merge semantics
---------------
* Recursion proceeds by object keys and array indices; a value missing
  from one of the three trees is treated as ``null`` for comparison.
* If only one side changed relative to ``base``, that side wins; if both
  sides made the same change, it is adopted; if both sides changed the
  same value differently, a conflict is recorded at that JSON Pointer
  and the ``ours`` value is used in the merged output.
* Objects: a key added with the same value on both sides is adopted,
  with different values it conflicts; a key deleted on one side and
  modified on the other conflicts.
* Arrays: merged positionally; an out-of-range append on only one side
  is adopted; different values placed at the same new index conflict.
  Array slots whose merged value is "missing" are emitted as ``null``;
  object keys whose merged value is "missing" are omitted.
"""

__all__ = ["MISSING", "merge3", "json_pointer"]

__version__ = "1.0.0"


class _Missing:
    _instance = None

    def __new__(cls):
        if cls._instance is None:
            cls._instance = super().__new__(cls)
        return cls._instance

    def __repr__(self):
        return "MISSING"


MISSING = _Missing()


def _norm(value):
    return None if value is MISSING else value


def _deep_eq(left, right):
    """JSON-aware structural equality (bool is distinct from number)."""
    if isinstance(left, bool) or isinstance(right, bool):
        return type(left) is type(right) and left == right
    if isinstance(left, dict) and isinstance(right, dict):
        if set(left) != set(right):
            return False
        return all(_deep_eq(left[key], right[key]) for key in left)
    if isinstance(left, list) and isinstance(right, list):
        return len(left) == len(right) and all(
            _deep_eq(a, b) for a, b in zip(left, right)
        )
    if isinstance(left, (int, float)) and isinstance(right, (int, float)):
        return left == right
    return type(left) is type(right) and left == right


def _same(left, right):
    """Equality where a missing value counts as null."""
    return _deep_eq(_norm(left), _norm(right))


def _escape(token):
    return token.replace("~", "~0").replace("/", "~1")


def json_pointer(path):
    """Render a path tuple of keys/indices as an RFC 6901 JSON Pointer."""
    return "".join("/" + _escape(str(token)) for token in path)


def _merge(base, ours, theirs, path, conflicts):
    if _same(ours, theirs):
        return ours
    if _same(base, ours):
        return theirs
    if _same(base, theirs):
        return ours

    if isinstance(ours, dict) and isinstance(theirs, dict):
        base_dict = base if isinstance(base, dict) else {}
        keys = list(dict.fromkeys(
            list(base_dict) + list(ours) + list(theirs)
        ))
        result = {}
        for key in keys:
            merged = _merge(
                base_dict.get(key, MISSING),
                ours.get(key, MISSING),
                theirs.get(key, MISSING),
                path + (key,),
                conflicts,
            )
            if merged is not MISSING:
                result[key] = merged
        return result

    if isinstance(ours, list) and isinstance(theirs, list):
        base_list = base if isinstance(base, list) else []
        size = max(len(base_list), len(ours), len(theirs))
        result = []
        for index in range(size):
            merged = _merge(
                base_list[index] if index < len(base_list) else MISSING,
                ours[index] if index < len(ours) else MISSING,
                theirs[index] if index < len(theirs) else MISSING,
                path + (index,),
                conflicts,
            )
            result.append(None if merged is MISSING else merged)
        return result

    conflicts.append(path)
    return ours


def merge3(base, ours, theirs):
    """Merge ``ours`` and ``theirs`` against ``base``.

    Returns ``(merged, conflicts)`` where ``conflicts`` is a list of
    JSON Pointer strings.
    """
    conflicts = []
    merged = _merge(base, ours, theirs, (), conflicts)
    if merged is MISSING:
        merged = None
    return merged, [json_pointer(path) for path in conflicts]
