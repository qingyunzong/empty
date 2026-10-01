"""Generators, value sizing, canonical ordering and shrink candidates.

Supported generator specs (JSON dictionaries):
    {"type": "int", "min": 0, "max": 10}
    {"type": "list", "of": <gen>, "min_length": 0, "max_length": 8}
    {"type": "dict", "fields": {"name": <gen>, ...}}
    {"type": "oneof", "choices": [<gen>, ...]}
"""

import hashlib
import json

# Bumping this invalidates every cached failure, as does any change to a
# (normalized) generator spec, because both feed into gen_version().
GEN_LIB_VERSION = "1"


class SpecError(Exception):
    """Raised when a spec (or generator) is invalid. Maps to CLI exit 2."""


def canonical(value):
    """Canonical JSON string for a generated value (total, injective)."""
    return json.dumps(value, sort_keys=True, separators=(",", ":"))


def size_of(value):
    """Size metric used to order shrink candidates (smaller is simpler)."""
    if isinstance(value, bool):
        return int(value)
    if isinstance(value, int):
        return abs(value)
    if isinstance(value, str):
        return len(value)
    if isinstance(value, list):
        return len(value) + sum(size_of(item) for item in value)
    if isinstance(value, dict):
        return len(value) + sum(
            size_of(key) + size_of(item) for key, item in value.items()
        )
    raise SpecError("no size defined for value of type %s" % type(value).__name__)


def order_key(value):
    """Total order on values: size ascending, ties broken by JSON order."""
    return (size_of(value), canonical(value))


def _check_int(value, what):
    if isinstance(value, bool) or not isinstance(value, int):
        raise SpecError("%s must be an integer" % what)
    return value


def normalize_gen(spec):
    """Validate a generator spec and return its normalized (canonical) form."""
    if not isinstance(spec, dict):
        raise SpecError("generator must be an object")
    gtype = spec.get("type")
    if gtype == "int":
        lo = _check_int(spec.get("min", 0), "int.min")
        hi = _check_int(spec.get("max", 100), "int.max")
        if lo > hi:
            raise SpecError("int.min must be <= int.max")
        return {"type": "int", "min": lo, "max": hi}
    if gtype == "list":
        if "of" not in spec:
            raise SpecError("list generator requires 'of'")
        of = normalize_gen(spec["of"])
        lo = _check_int(spec.get("min_length", 0), "list.min_length")
        hi = _check_int(spec.get("max_length", 8), "list.max_length")
        if lo < 0:
            raise SpecError("list.min_length must be >= 0")
        if lo > hi:
            raise SpecError("list.min_length must be <= list.max_length")
        return {"type": "list", "of": of, "min_length": lo, "max_length": hi}
    if gtype == "dict":
        fields = spec.get("fields")
        if not isinstance(fields, dict) or not fields:
            raise SpecError("dict generator requires non-empty 'fields' object")
        normalized = {}
        for name, sub in fields.items():
            if not isinstance(name, str):
                raise SpecError("dict field names must be strings")
            normalized[name] = normalize_gen(sub)
        return {"type": "dict", "fields": normalized}
    if gtype == "oneof":
        choices = spec.get("choices")
        if not isinstance(choices, list) or not choices:
            raise SpecError("oneof generator requires non-empty 'choices' list")
        return {"type": "oneof", "choices": [normalize_gen(c) for c in choices]}
    raise SpecError("unknown generator type: %r" % (gtype,))


def gen_version(gen):
    """Version fingerprint of a normalized generator spec.

    Includes the generator library version, so cached failures are keyed by
    (property name, generator version) and any spec/library change
    invalidates old cache entries.
    """
    payload = "propcore-gen-v%s|%s" % (GEN_LIB_VERSION, canonical(gen))
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()[:16]


def generate(gen, rng):
    """Draw one value from the generator using the shared random source."""
    gtype = gen["type"]
    if gtype == "int":
        return rng.randint(gen["min"], gen["max"])
    if gtype == "list":
        length = rng.randint(gen["min_length"], gen["max_length"])
        return [generate(gen["of"], rng) for _ in range(length)]
    if gtype == "dict":
        return {name: generate(sub, rng) for name, sub in gen["fields"].items()}
    if gtype == "oneof":
        choice = gen["choices"][rng.randrange(len(gen["choices"]))]
        return generate(choice, rng)
    raise SpecError("unknown generator type: %r" % (gtype,))


def fits(gen, value):
    """Whether value could have been produced by this generator."""
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
            and gen["min_length"] <= len(value) <= gen["max_length"]
            and all(fits(gen["of"], item) for item in value)
        )
    if gtype == "dict":
        return (
            isinstance(value, dict)
            and set(value.keys()) == set(gen["fields"].keys())
            and all(fits(gen["fields"][k], v) for k, v in value.items())
        )
    if gtype == "oneof":
        return any(fits(choice, value) for choice in gen["choices"])
    return False


def candidates(gen, value):
    """Shrink candidates for value under gen (unsorted, may contain dupes).

    The caller sorts them with order_key: size ascending, JSON order on ties.
    """
    gtype = gen["type"]
    if gtype == "int":
        out = []
        for cand in (0, value // 2, value - 1, -value):
            if cand != value and gen["min"] <= cand <= gen["max"]:
                out.append(cand)
        return out
    if gtype == "list":
        out = []
        if len(value) > gen["min_length"]:
            for i in range(len(value)):
                out.append(value[:i] + value[i + 1:])
        for i, item in enumerate(value):
            for cand in candidates(gen["of"], item):
                out.append(value[:i] + [cand] + value[i + 1:])
        return out
    if gtype == "dict":
        out = []
        for name, sub in gen["fields"].items():
            for cand in candidates(sub, value[name]):
                new_value = dict(value)
                new_value[name] = cand
                out.append(new_value)
        return out
    if gtype == "oneof":
        out = []
        for choice in gen["choices"]:
            if fits(choice, value):
                out.extend(candidates(choice, value))
        return out
    raise SpecError("unknown generator type: %r" % (gtype,))
