"""Value generators, canonical ordering and shrink-candidate enumeration.

Determinism contract
--------------------
A single ``random.Random`` instance is the shared random source for the
whole run: generation draws from it directly, while shrinking is a purely
deterministic enumeration of canonically ordered candidates and never
draws from it.  A fixed seed therefore always reproduces the same run
sequence, whether or not shrinking or caching took place.

Canonical order
---------------
Values are ordered by ``(size(value), json_key(value))``: size ascending,
ties broken by JSON serialisation order.  Shrinking enumerates candidates
in this order and only ever moves to strictly smaller candidates, which
guarantees termination and a stable, discovery-order-independent minimal
counterexample.
"""

import json

# Version of the generator semantics.  It is part of every cache key, so
# bumping it invalidates all previously cached failures.
GEN_VERSION = "1"

# Int domains up to this size are enumerated exhaustively when shrinking,
# which makes shrinking on small domains agree with reference enumeration.
EXACT_INT_DOMAIN = 4096


def json_key(value):
    """Canonical JSON serialisation used as the tie-break order."""
    return json.dumps(value, sort_keys=True, separators=(",", ":"))


def size(value):
    """Structural size of a generated value."""
    if isinstance(value, bool):
        return int(value)
    if isinstance(value, int):
        return abs(value)
    if isinstance(value, float):
        return int(abs(value)) + 1
    if isinstance(value, str):
        return len(value)
    if isinstance(value, list):
        return len(value) + sum(size(item) for item in value)
    if isinstance(value, dict):
        return len(value) + sum(
            size(key) + size(item) for key, item in value.items()
        )
    if value is None:
        return 0
    raise TypeError("no size defined for %s" % type(value).__name__)


def order_key(value):
    return (size(value), json_key(value))


def generate(gen, rng):
    """Draw a value from ``gen`` using the shared random source ``rng``."""
    gtype = gen["type"]
    if gtype == "int":
        return rng.randint(gen["min"], gen["max"])
    if gtype == "list":
        count = rng.randint(gen.get("min_len", 0), gen["max_len"])
        return [generate(gen["of"], rng) for _ in range(count)]
    if gtype == "dict":
        return {name: generate(sub, rng) for name, sub in gen["fields"].items()}
    if gtype == "oneof":
        index = rng.randrange(len(gen["options"]))
        return generate(gen["options"][index], rng)
    raise ValueError("unknown generator type: %r" % (gtype,))


def validate_value(gen, value):
    """Check whether ``value`` could have been produced by ``gen``."""
    gtype = gen["type"]
    if gtype == "int":
        return (
            isinstance(value, int)
            and not isinstance(value, bool)
            and gen["min"] <= value <= gen["max"]
        )
    if gtype == "list":
        return (
            isinstance(value, list)
            and gen.get("min_len", 0) <= len(value) <= gen["max_len"]
            and all(validate_value(gen["of"], item) for item in value)
        )
    if gtype == "dict":
        fields = gen["fields"]
        return (
            isinstance(value, dict)
            and set(value) == set(fields)
            and all(validate_value(fields[name], value[name]) for name in fields)
        )
    if gtype == "oneof":
        return any(validate_value(option, value) for option in gen["options"])
    return False


def default_value(gen):
    """The canonically smallest value a generator can produce."""
    gtype = gen["type"]
    if gtype == "int":
        low, high = gen["min"], gen["max"]
        if low <= 0 <= high:
            return 0
        return low if low > 0 else high
    if gtype == "list":
        return [default_value(gen["of"])] * gen.get("min_len", 0)
    if gtype == "dict":
        return {name: default_value(sub) for name, sub in gen["fields"].items()}
    if gtype == "oneof":
        return min((default_value(opt) for opt in gen["options"]), key=order_key)
    raise ValueError("unknown generator type: %r" % (gtype,))


def shrink_candidates(gen, value):
    """Candidate shrinks for ``value``, deduplicated, canonically ordered.

    Every returned candidate is strictly smaller than ``value`` in the
    canonical order (enforced again by the shrink loop).
    """
    seen = set()
    unique = []
    for cand in _candidates(gen, value):
        key = json_key(cand)
        if key not in seen:
            seen.add(key)
            unique.append(cand)
    unique.sort(key=order_key)
    return unique


def _candidates(gen, value):
    gtype = gen["type"]
    if gtype == "int":
        return _int_candidates(gen, value)
    if gtype == "list":
        return _list_candidates(gen, value)
    if gtype == "dict":
        return _dict_candidates(gen, value)
    if gtype == "oneof":
        return _oneof_candidates(gen, value)
    raise ValueError("unknown generator type: %r" % (gtype,))


def _int_candidates(gen, value):
    low, high = gen["min"], gen["max"]
    cands = set()
    if high - low + 1 <= EXACT_INT_DOMAIN:
        for cand in range(low, high + 1):
            if abs(cand) < abs(value):
                cands.add(cand)
    else:
        if low <= 0 <= high:
            cands.add(0)
        step = value - 1 if value > 0 else value + 1
        if low <= step <= high:
            cands.add(step)
        probe = value
        while probe != 0:
            probe = probe // 2 if probe > 0 else -((-probe) // 2)
            if low <= probe <= high:
                cands.add(probe)
    # Same-size negation, only when canonically smaller: this makes the
    # choice between tied minimal counterexamples (e.g. -2 vs 2) stable.
    negated = -value
    if (
        low <= negated <= high
        and negated != value
        and json_key(negated) < json_key(value)
    ):
        cands.add(negated)
    cands.discard(value)
    return list(cands)


def _list_candidates(gen, value):
    cands = []
    if len(value) > gen.get("min_len", 0):
        for index in range(len(value)):
            cands.append(value[:index] + value[index + 1:])
    sub = gen["of"]
    for index, item in enumerate(value):
        for cand in shrink_candidates(sub, item):
            cands.append(value[:index] + [cand] + value[index + 1:])
    return cands


def _dict_candidates(gen, value):
    cands = []
    for name, sub in gen["fields"].items():
        for cand in shrink_candidates(sub, value[name]):
            shrunk = dict(value)
            shrunk[name] = cand
            cands.append(shrunk)
    return cands


def _oneof_candidates(gen, value):
    cands = []
    for option in gen["options"]:
        if validate_value(option, value):
            cands.extend(_candidates(option, value))
        # The canonical minimum of every option enables cross-option
        # shrinking; the shrink loop keeps it only if it is smaller.
        cands.append(default_value(option))
    return cands
