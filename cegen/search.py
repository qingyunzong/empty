"""Layered exhaustive search over finite domains.

Enumeration order: assignments are layered by total cost (sum of per-variable
value costs); within a layer, assignments are ordered lexicographically by the
tuple of canonical domain indices. The first falsifying assignment found is
therefore the minimal counterexample under (total_cost, lex) order.

Statuses:
  COUNTEREXAMPLE - a minimal falsifying assignment was found
  PROOF          - every assignment in the finite space satisfies the predicate
  UNKNOWN        - the resource limit was hit; NOT a proof of safety
  INVALID_INPUT  - the predicate raised on some assignment before any smaller
                   counterexample was found
"""
from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass
from typing import Optional

from .predicate import evaluate

COUNTEREXAMPLE = "COUNTEREXAMPLE"
PROOF = "PROOF"
UNKNOWN = "UNKNOWN"
INVALID_INPUT = "INVALID_INPUT"


@dataclass
class SearchResult:
    status: str
    counterexample: Optional[dict]
    enumerated: int
    closure_hash: Optional[str] = None


def jsonable(value):
    """Convert internal tuples to lists (for JSON output and predicate env)."""
    if isinstance(value, (tuple, list)):
        return [jsonable(v) for v in value]
    return value


def _cost_blocks(domain):
    blocks = {}
    for idx, cost in enumerate(domain.costs):
        blocks.setdefault(cost, []).append(idx)
    return blocks


def _layer_indices(blocks, total):
    """Yield index tuples (one index per variable) whose costs sum to total."""
    if not blocks:
        if total == 0:
            yield ()
        return
    first, rest = blocks[0], blocks[1:]
    for cost in sorted(first):
        if cost > total:
            break
        tails = list(_layer_indices(rest, total - cost))
        for idx in first[cost]:
            for tail in tails:
                yield (idx,) + tail


def search(domains, code, limit=None):
    blocks = [_cost_blocks(d) for d in domains]
    max_cost = sum(max(b) for b in blocks) if blocks else 0
    names = [d.name for d in domains]
    enumerated = 0
    hasher = hashlib.sha256()
    for cost in range(max_cost + 1):
        layer = sorted(_layer_indices(blocks, cost))
        for combo in layer:
            if limit is not None and enumerated >= limit:
                return SearchResult(UNKNOWN, None, enumerated)
            enumerated += 1
            values = [d.values[i] for d, i in zip(domains, combo)]
            hasher.update(
                json.dumps([jsonable(v) for v in values],
                           separators=(",", ":")).encode()
            )
            hasher.update(b"\n")
            env = {n: jsonable(v) for n, v in zip(names, values)}
            try:
                holds = evaluate(code, env)
            except Exception:
                return SearchResult(INVALID_INPUT, None, enumerated)
            if not holds:
                counterexample = {n: jsonable(v) for n, v in zip(names, values)}
                return SearchResult(COUNTEREXAMPLE, counterexample, enumerated)
    return SearchResult(PROOF, None, enumerated, hasher.hexdigest())
