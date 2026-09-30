"""High-level entry point shared by the CLI and tests."""
from __future__ import annotations

from .domains import build_domain
from .errors import PolicyError
from .predicate import compile_predicate
from .search import PROOF, UNKNOWN, search
from .spec import resolve_bound, resolve_max_len, validate_spec


def find(spec, bound=None, max_len=None, max_enumerated=None):
    """Run a bounded search. Returns {status, counterexample, stats}."""
    spec = validate_spec(spec)
    bound = resolve_bound(spec, bound)
    max_len = resolve_max_len(spec, max_len)
    if max_enumerated is not None:
        if isinstance(max_enumerated, bool) or not isinstance(max_enumerated, int) \
                or max_enumerated < 0:
            raise PolicyError(
                f"max_enumerated must be a non-negative integer, got {max_enumerated!r}")
    domains = [
        build_domain(var["name"], var, bound, max_len)
        for var in spec["variables"]
    ]
    code = compile_predicate(spec["predicate"])
    result = search(domains, code, limit=max_enumerated)
    stats = {
        "enumerated": result.enumerated,
        "bound": bound,
        "max_len": max_len,
        "exhausted": result.status != UNKNOWN,
    }
    if result.status == PROOF:
        stats["closure_hash"] = result.closure_hash
    if result.status == UNKNOWN:
        stats["limit"] = max_enumerated
    return {
        "status": result.status,
        "counterexample": result.counterexample,
        "stats": stats,
    }
