"""Vector-clock helpers. Vectors are dicts mapping replica id -> counter."""


def merge(a, b):
    """Component-wise max of two vectors."""
    out = dict(a)
    for k, v in b.items():
        if v > out.get(k, 0):
            out[k] = v
    return out


def leq(a, b):
    """True iff a happens-before-or-equals b (component-wise <=)."""
    for k in set(a) | set(b):
        if a.get(k, 0) > b.get(k, 0):
            return False
    return True


def concurrent(a, b):
    """True iff neither a <= b nor b <= a."""
    return not leq(a, b) and not leq(b, a)


def minimum(vectors):
    """Component-wise min of a non-empty iterable of vectors."""
    vectors = list(vectors)
    keys = set()
    for v in vectors:
        keys |= set(v)
    return {k: min(v.get(k, 0) for v in vectors) for k in keys}
