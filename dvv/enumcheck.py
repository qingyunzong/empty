"""Exhaustive verification of legal delivery orders.

The event DAG and its transitive closure are computed independently of the
delivery machinery (Warshall over dots).  Verification is a BFS over legal
delivery sequences, deduplicated by ``(delivered set, node-state digest)`` so
that up to 4 replicas / 12 events stay tractable.  On failure the shortest
counterexample delivery sequence is reported.
"""
from __future__ import annotations

import json
from collections import deque
from functools import lru_cache

from .event import PUT, Event
from .node import Node


def build_dependencies(events):
    """Direct causal edges restricted to the given event set."""
    dots = {e.dot for e in events}
    return {e.dot: {d for d in e.context.dots() if d != e.dot and d in dots}
            for e in events}


def transitive_closure(deps):
    """Independent Warshall closure: reach[a] = all ancestors of a."""
    dots = list(deps)
    reach = {a: set(bs) for a, bs in deps.items()}
    for k in dots:
        for a in dots:
            if k in reach[a]:
                reach[a] |= reach[k]
    return reach


def relation_matrix(events):
    """Classify every event pair as causally ordered or concurrent."""
    deps = build_dependencies(events)
    reach = transitive_closure(deps)
    ordered = sorted(events, key=lambda e: e.dot)
    before, concurrent = [], []
    for i, a in enumerate(ordered):
        for b in ordered[i + 1:]:
            if a.dot in reach[b.dot]:
                before.append((a.dot, b.dot))
            elif b.dot in reach[a.dot]:
                before.append((b.dot, a.dot))
            else:
                concurrent.append((a.dot, b.dot))
    return {"before": before, "concurrent": concurrent}


def count_linear_extensions(events, cap=100_000_000):
    """Number of legal delivery orders (DP over subsets of the DAG)."""
    deps = build_dependencies(events)
    dots = tuple(sorted(deps))
    index = {d: i for i, d in enumerate(dots)}
    dep_mask = [0] * len(dots)
    for d in dots:
        for x in deps[d]:
            dep_mask[index[d]] |= 1 << index[x]
    full = (1 << len(dots)) - 1

    @lru_cache(maxsize=None)
    def go(done):
        if done == full:
            return 1
        total = 0
        for i in range(len(dots)):
            if done >> i & 1 or dep_mask[i] & ~done:
                continue
            total += go(done | (1 << i))
            if total > cap:
                return total
        return total

    return go(0)


def expected_values(events, key):
    """Causally maximal put values among *events* for *key*."""
    puts = [e for e in events if e.key == key and e.kind == PUT]
    live = []
    for p in puts:
        dominated = any(other is not p and other.key == key
                        and p.context.leq(other.context)
                        for other in events)
        if not dominated:
            live.append(p)
    return sorted(p.value for p in live)


def _state_digest(node):
    return json.dumps(node.snapshot(), sort_keys=True)


def verify(events, keys=None, node_factory=None, max_states=200_000,
           redeliver=False):
    """BFS over legal delivery sequences.

    At every reached state, reads on every key must equal the causally
    maximal values derived from the independent event DAG.  Returns a
    report dict; on failure it contains ``counterexample`` — the shortest
    delivery sequence that breaks the invariant.

    With ``redeliver=True`` every reached state additionally re-delivers
    all already-delivered events (duplicate / replay traffic) before the
    invariant is checked — this catches tombstones reclaimed too early and
    missing duplicate suppression.
    """
    node_factory = node_factory or (lambda: Node("verifier"))
    keys = keys if keys is not None else sorted({e.key for e in events})
    by_dot = {e.dot: e for e in events}
    if len(by_dot) != len(events):
        raise ValueError("duplicate event dots")
    deps = build_dependencies(events)
    relations = relation_matrix(events)

    def check(node):
        for key in keys:
            actual = sorted(item["value"] for item in node.read(key))
            delivered = [by_dot[d] for d in node.delivered.dots() if d in by_dot]
            expected = expected_values(delivered, key)
            if actual != expected:
                return {"key": key, "expected": expected, "actual": actual}
        return None

    start = node_factory()
    failure = check(start)
    if failure:
        return {"status": "fail", "counterexample": [], **failure,
                "relations": relations}

    # BFS states: (delivered frozenset, order tuple, node)
    seen = {(frozenset(), _state_digest(start))}
    queue = deque([(frozenset(), (), start)])
    states = 1
    while queue:
        subset, order, node = queue.popleft()
        for dot in sorted(by_dot):
            if dot in subset or not deps[dot] <= subset:
                continue
            nxt_node = _clone_state(node)
            status = nxt_node.deliver(by_dot[dot])
            if status != "delivered":
                return {"status": "fail",
                        "counterexample": [list(d) for d in order + (dot,)],
                        "error": f"legal delivery rejected: {status}",
                        "relations": relations}
            nxt_subset = subset | {dot}
            nxt_order = order + (dot,)
            if redeliver:
                for replay_dot in nxt_order:
                    nxt_node.deliver(by_dot[replay_dot])
            digest = (nxt_subset, _state_digest(nxt_node))
            failure = check(nxt_node)
            if failure:
                return {"status": "fail",
                        "counterexample": [list(d) for d in nxt_order],
                        "replayed": redeliver,
                        **failure, "relations": relations}
            if digest not in seen:
                seen.add(digest)
                states += 1
                if states > max_states:
                    return {"status": "truncated", "states": states,
                            "relations": relations}
                queue.append((nxt_subset, nxt_order, nxt_node))
    return {"status": "ok", "states": states,
            "orders": count_linear_extensions(events),
            "relations": relations}


def _clone_state(node):
    import copy
    return copy.deepcopy(node)
