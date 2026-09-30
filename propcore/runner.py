"""The property-test runner: generate, check, shrink, cache.

Semantics implemented here:

1. One ``random.Random(seed)`` drives all generation; shrinking is
   deterministic and shares (but does not consume) that random source, so
   a fixed seed reproduces the exact run sequence.
2. Shrinking only ever operates on the current failing value, walking
   candidates in canonical order (size ascending, JSON tie-break).
3. A cache hit re-runs the property once to confirm; only a confirmed
   failure is skipped and reported as KNOWN_FAIL.  A stale entry that now
   passes is discarded, so the cache can never mask failures.
4. A newly discovered failure takes priority over KNOWN_FAIL in the
   reported status.
5. Exceptions raised while running a property count as failures, reported
   with kind ``ERROR`` and kept separate from ``PROPERTY_FAIL``.
"""

import random

from .cache import Cache, make_key
from .expr import compile_expr, evaluate
from .generators import GEN_VERSION, generate, order_key, shrink_candidates

MAX_SHRINK_STEPS = 1000
MAX_SHRINK_CHECKS = 10000

KIND_PROPERTY_FAIL = "PROPERTY_FAIL"
KIND_ERROR = "ERROR"


def _kind_of(outcome):
    return KIND_ERROR if outcome == "error" else KIND_PROPERTY_FAIL


def _reproduces(outcome, kind):
    if kind == KIND_ERROR:
        return outcome == "error"
    return outcome == "fail"


def shrink(code, gen, value, kind):
    """Greedily shrink ``value`` to a canonical minimal failing value.

    Only the current failing value is shrunk; candidates are tried in
    canonical order and the first one reproducing the same failure kind is
    adopted.  Returns ``(minimal_value, shrink_steps)``.
    """
    current = value
    steps = 0
    checks = 0
    while steps < MAX_SHRINK_STEPS:
        current_order = order_key(current)
        moved = False
        for cand in shrink_candidates(gen, current):
            if order_key(cand) >= current_order:
                break
            checks += 1
            if checks > MAX_SHRINK_CHECKS:
                return current, steps
            outcome, _ = evaluate(code, cand)
            if _reproduces(outcome, kind):
                current = cand
                steps += 1
                moved = True
                break
        if not moved:
            return current, steps
    return current, steps


def _record_failure(failures, key, prop_name, kind, value, original,
                    run_index, known, shrinks, error):
    if key in failures:
        return
    record = {
        "property": prop_name,
        "kind": kind,
        "value": value,
        "original": original,
        "run": run_index,
        "known": known,
        "shrinks": shrinks,
    }
    if error is not None:
        record["error"] = error
    failures[key] = record


def run_spec(spec, runs, seed=0, db_path=None):
    """Run every property in ``spec`` ``runs`` times. Returns the report."""
    rng = random.Random(seed)
    cache = Cache(db_path)
    failures = {}
    total_shrinks = 0
    total_runs = 0
    for prop in spec["properties"]:
        name = prop["name"]
        gen = prop["gen"]
        source = prop["expr"]
        code = compile_expr(source)
        for run_index in range(runs):
            total_runs += 1
            value = generate(gen, rng)
            key = make_key(name, gen, source, GEN_VERSION, value)
            if cache.get(key) is not None:
                # Known-failure hit: re-run once to confirm before skipping.
                outcome, detail = evaluate(code, value)
                if outcome == "pass":
                    cache.discard(key)  # stale entry; must not mask anything
                    continue
                _record_failure(
                    failures, key, name, _kind_of(outcome), value, value,
                    run_index, True, 0, detail,
                )
                continue
            outcome, detail = evaluate(code, value)
            if outcome == "pass":
                continue
            kind = _kind_of(outcome)
            shrunk, steps = shrink(code, gen, value, kind)
            total_shrinks += steps
            shrunk_key = make_key(name, gen, source, GEN_VERSION, shrunk)
            known = cache.get(shrunk_key) is not None
            final_outcome, final_detail = evaluate(code, shrunk)
            final_kind = _kind_of(final_outcome)
            cache.add(shrunk_key, {
                "property": name,
                "kind": final_kind,
                "value": shrunk,
            })
            _record_failure(
                failures, shrunk_key, name, final_kind, shrunk, value,
                run_index, known, steps, final_detail,
            )
    cache.save()
    ordered = sorted(
        failures.values(),
        key=lambda rec: (rec["property"], order_key(rec["value"])),
    )
    if not ordered:
        status = "PASS"
    elif any(not rec["known"] for rec in ordered):
        status = "FAIL"
    else:
        status = "KNOWN_FAIL"
    return {
        "status": status,
        "runs": total_runs,
        "failures": ordered,
        "shrinks": total_shrinks,
    }
