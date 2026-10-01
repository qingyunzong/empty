"""Test execution engine: generation, shrinking and the known-failure cache."""

import random

from .expr import evaluate
from .generators import candidates, canonical, gen_version, generate, order_key

PASS = "PASS"
PROPERTY_FAIL = "PROPERTY_FAIL"
ERROR = "ERROR"
KNOWN_FAIL = "KNOWN_FAIL"

# Overall status priority: a fresh failure always beats a known one.
_PRIORITY = {PASS: 0, KNOWN_FAIL: 1, PROPERTY_FAIL: 2, ERROR: 3}

MAX_SHRINK_STEPS = 1000


def check(prop, value):
    """Evaluate a property; returns PASS, PROPERTY_FAIL or ERROR."""
    try:
        ok = bool(evaluate(prop, value))
    except Exception:
        return ERROR
    return PASS if ok else PROPERTY_FAIL


def cache_key(prop):
    """Cache key: property name + generator version."""
    return "%s|%s" % (prop["name"], gen_version(prop["gen"]))


def shrink(prop, value, kind, rng=None):
    """Greedily shrink a failing value.

    Only the current failing value is shrunk. Candidates are ordered by size
    ascending with JSON order on ties; the first candidate that still fails
    with the same kind and is strictly smaller in that order is accepted.
    Deterministic by construction; shares the run's random source (rng) so
    generation and shrinking never diverge across reseeds.
    """
    current = value
    steps = 0
    while steps < MAX_SHRINK_STEPS:
        current_key = order_key(current)
        best = None
        best_key = None
        seen = set()
        for cand in candidates(prop["gen"], current):
            marker = canonical(cand)
            if marker in seen:
                continue
            seen.add(marker)
            cand_key = order_key(cand)
            if cand_key >= current_key:
                continue
            if best_key is not None and cand_key >= best_key:
                continue
            if check(prop, cand) == kind:
                best = cand
                best_key = cand_key
        if best is None:
            break
        current = best
        steps += 1
    return current, steps


def run_property(prop, runs, seed, db=None):
    """Run one property. Returns a per-property result dict."""
    name = prop["name"]
    if db is not None:
        key = cache_key(prop)
        entry = db["failures"].get(key)
        if entry is not None:
            # Cache hit: re-run the cached counterexample once to confirm.
            # Only a confirmed failure is skipped and reported KNOWN_FAIL;
            # a stale entry is dropped and the property runs in full, so the
            # cache can never mask a new (or healed) failure.
            if check(prop, entry["counterexample"]) != PASS:
                return {
                    "property": name,
                    "status": KNOWN_FAIL,
                    "kind": KNOWN_FAIL,
                    "cached_kind": entry.get("kind"),
                    "counterexample": entry["counterexample"],
                    "runs": 0,
                    "shrinks": 0,
                }
            del db["failures"][key]
    rng = random.Random(seed)
    for i in range(runs):
        value = generate(prop["gen"], rng)
        kind = check(prop, value)
        if kind != PASS:
            shrunk, steps = shrink(prop, value, kind, rng)
            if db is not None:
                db["failures"][cache_key(prop)] = {
                    "kind": kind,
                    "counterexample": shrunk,
                }
            return {
                "property": name,
                "status": kind,
                "kind": kind,
                "counterexample": shrunk,
                "original": value,
                "runs": i + 1,
                "shrinks": steps,
            }
    return {"property": name, "status": PASS, "runs": runs, "shrinks": 0}


def run_spec(spec, runs, seed, db=None):
    """Run all properties in a normalized spec. Returns the report dict."""
    per_property = []
    failures = []
    total_runs = 0
    total_shrinks = 0
    for prop in spec["properties"]:
        result = run_property(prop, runs, seed, db)
        per_property.append(result)
        total_runs += result["runs"]
        total_shrinks += result["shrinks"]
        if result["status"] != PASS:
            failures.append(result)
    status = PASS
    for result in per_property:
        if _PRIORITY[result["status"]] > _PRIORITY[status]:
            status = result["status"]
    return {
        "status": status,
        "runs": total_runs,
        "failures": failures,
        "shrinks": total_shrinks,
        "properties": per_property,
    }
