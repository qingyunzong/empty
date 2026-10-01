"""Scalar value typing and encoding.

The store distinguishes lexical numeric types: JSON integers and JSON
decimals (floats) are different types, and booleans are never treated as
integers even though Python models ``bool`` as a subclass of ``int``.
"""

TAG_NULL = "n"
TAG_BOOL = "b"
TAG_INT = "i"
TAG_FLOAT = "f"
TAG_STR = "s"

TAG_ORDER = {TAG_NULL: 0, TAG_BOOL: 1, TAG_INT: 2, TAG_FLOAT: 3, TAG_STR: 4}


def is_scalar(value):
    return value is None or isinstance(value, (bool, int, float, str))


def type_tag(value):
    if value is None:
        return TAG_NULL
    if isinstance(value, bool):
        return TAG_BOOL
    if isinstance(value, int):
        return TAG_INT
    if isinstance(value, float):
        return TAG_FLOAT
    if isinstance(value, str):
        return TAG_STR
    raise TypeError(f"not a JSON scalar: {type(value).__name__}")


def value_key(value):
    """Lossless, type-discriminating key used inside index entry maps."""
    tag = type_tag(value)
    if tag == TAG_NULL:
        body = "null"
    elif tag == TAG_BOOL:
        body = "true" if value else "false"
    elif tag == TAG_STR:
        body = value
    else:
        body = repr(value)
    return tag + ":" + body


def sort_key(value):
    """Ordering key: group by lexical type, then by value within the type."""
    return (TAG_ORDER[type_tag(value)], value)


def json_equal(left, right):
    """Deep equality with strict lexical typing.

    ``1`` does not equal ``1.0`` and ``True`` does not equal ``1``.
    """
    if isinstance(left, dict) and isinstance(right, dict):
        if left.keys() != right.keys():
            return False
        return all(json_equal(left[k], right[k]) for k in left)
    if isinstance(left, list) and isinstance(right, list):
        if len(left) != len(right):
            return False
        return all(json_equal(a, b) for a, b in zip(left, right))
    if is_scalar(left) and is_scalar(right):
        return type_tag(left) == type_tag(right) and left == right
    return False
