"""Layered exhaustive search for minimal counterexamples.

Enumeration order is part of the semantics: assignments are grouped into
cost layers in non-decreasing cost, and within a layer they are visited in
lexicographic order over the declared variable order. The first assignment
on which the invariant predicate is False is therefore the unique minimal
counterexample (cost-minimal, lex-minimal among ties).

A run ends in exactly one of four states:

* COUNTEREXAMPLE  - a minimal counterexample was found
* PROOF           - the whole bounded space was enumerated and the
                    invariant held everywhere; carries a closure hash
* UNKNOWN         - the resource cap (max predicate evaluations) was hit
                    before the space was exhausted; NOT a proof
* INVALID_INPUT   - the predicate raised (or returned a non-bool); this is
                    a policy input defect, never a counterexample
"""
from __future__ import annotations

import hashlib
import itertools
import json
from dataclasses import dataclass
from typing import Any, Optional

from .spec import SAFE_FUNCS, Spec

COUNTEREXAMPLE = "COUNTEREXAMPLE"
PROOF = "PROOF"
UNKNOWN = "UNKNOWN"
INVALID_INPUT = "INVALID_INPUT"


@dataclass(frozen=True)
class SearchResult:
    status: str
    counterexample: Optional[dict]
    stats: dict

    def to_dict(self) -> dict:
        return {
            "status": self.status,
            "counterexample": self.counterexample,
            "stats": self.stats,
        }


def _canonical_json(obj: Any) -> bytes:
    return json.dumps(obj, sort_keys=True, separators=(",", ":")).encode("utf-8")


def _jsonable(value):
    if isinstance(value, tuple):
        return [_jsonable(item) for item in value]
    return value


def assignment_dict(spec: Spec, assignment: tuple) -> dict:
    """Canonical public form: lists for list values, JSON-serialisable."""
    return {
        var.name: _jsonable(value)
        for var, value in zip(spec.variables, assignment)
    }


def _evaluate(spec: Spec, assignment: tuple):
    env = dict(SAFE_FUNCS)
    env.update((var.name, value) for var, value in zip(spec.variables, assignment))
    try:
        outcome = eval(spec.code, {"__builtins__": {}}, env)
    except Exception as exc:  # any predicate failure is invalid policy input
        return None, f"{type(exc).__name__}: {exc}"
    if not isinstance(outcome, bool):
        return None, f"predicate returned non-boolean value of type {type(outcome).__name__}"
    return outcome, None


def enumerate_space(spec: Spec):
    """Return cost -> assignments (in product/lexicographic order) and size."""
    domains = [var.domain for var in spec.variables]
    layers: dict = {}
    space_size = 0
    for assignment in itertools.product(*(domain.values for domain in domains)):
        cost = sum(
            domain.cost(value)
            for domain, value in zip(domains, assignment)
        )
        layers.setdefault(cost, []).append(assignment)
        space_size += 1
    return layers, space_size


def search(spec: Spec, max_steps: Optional[int] = None) -> SearchResult:
    """Run the layered search.

    max_steps caps the number of predicate evaluations. Hitting the cap
    yields UNKNOWN with the number of assignments actually enumerated;
    UNKNOWN is never interpreted as absence of a counterexample.
    """
    if max_steps is not None and (isinstance(max_steps, bool) or max_steps < 0):
        raise ValueError("max_steps must be a non-negative integer or None")

    layers, space_size = enumerate_space(spec)
    stats = {
        "bound": spec.default_bound,
        "enumerated": 0,
        "layers": len(layers),
        "max_steps": max_steps,
        "space_size": space_size,
    }

    enumerated = 0
    for cost in sorted(layers):
        for assignment in layers[cost]:
            if max_steps is not None and enumerated >= max_steps:
                stats["enumerated"] = enumerated
                stats["exhausted"] = False
                return SearchResult(UNKNOWN, None, stats)
            enumerated += 1
            holds, error = _evaluate(spec, assignment)
            if error is not None:
                stats["enumerated"] = enumerated
                stats["error"] = error
                stats["assignment"] = assignment_dict(spec, assignment)
                return SearchResult(INVALID_INPUT, None, stats)
            if not holds:
                stats["enumerated"] = enumerated
                stats["cost"] = cost
                return SearchResult(
                    COUNTEREXAMPLE, assignment_dict(spec, assignment), stats
                )

    # No counterexample anywhere in the bounded space: this is a proof.
    hasher = hashlib.sha256()
    for cost in sorted(layers):
        for assignment in layers[cost]:
            hasher.update(_canonical_json(assignment_dict(spec, assignment)))
            hasher.update(b"\n")
    stats["enumerated"] = enumerated
    stats["exhausted"] = True
    stats["closure_hash"] = hasher.hexdigest()
    return SearchResult(PROOF, None, stats)
