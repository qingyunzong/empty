"""Exhaustive delivery-order enumeration for small topologies (<= 4
replicas, <= 12 write events) and independent cross-checking against the
transitive closure of the event DAG.

A *scenario* is a set of writes with explicit causal dependencies.  A
delivery sequence is legal when every write reaches every replica only
after all of its dependencies reached that replica.  For each legal
sequence the simulator is driven directly (bypassing the network queue)
and the resulting reads are checked against the expectation computed
purely from the DAG: the causally maximal writes per key.
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Callable, Dict, List, Optional, Sequence, Set, Tuple

from .store import Replica

MAX_REPLICAS = 4
MAX_EVENTS = 12
DEFAULT_LIMIT = 200_000


@dataclass(frozen=True)
class WriteSpec:
    wid: str
    node: str
    key: str
    deps: Tuple[str, ...] = ()


def with_session_order(specs: Sequence[WriteSpec]) -> List[WriteSpec]:
    """Writes on the same origin are causally ordered by declaration order."""
    last_on: Dict[str, str] = {}
    result: List[WriteSpec] = []
    for s in specs:
        deps = list(s.deps)
        if s.node in last_on and last_on[s.node] not in deps:
            deps.append(last_on[s.node])
        result.append(WriteSpec(s.wid, s.node, s.key, tuple(deps)))
        last_on[s.node] = s.wid
    return result


def transitive_closure(specs: Sequence[WriteSpec]) -> Dict[str, Set[str]]:
    """wid -> set of wids that happen-before it (transitively)."""
    specs = with_session_order(specs)
    by_id = {s.wid: s for s in specs}
    closure: Dict[str, Set[str]] = {s.wid: set() for s in specs}

    def visit(wid: str) -> Set[str]:
        if closure[wid]:
            return closure[wid]
        seen: Set[str] = set()
        for dep in by_id[wid].deps:
            seen.add(dep)
            seen |= visit(dep)
        closure[wid] = seen
        return seen

    for s in specs:
        visit(s.wid)
    return closure


def happens_before(closure: Dict[str, Set[str]], a: str, b: str) -> bool:
    return a in closure.get(b, set())


def concurrent(closure: Dict[str, Set[str]], a: str, b: str) -> bool:
    return a != b and not happens_before(closure, a, b) \
        and not happens_before(closure, b, a)


def expected_maximal(specs: Sequence[WriteSpec]) -> Dict[str, Set[str]]:
    """Per key, the writes no other same-key write causally supersedes."""
    closure = transitive_closure(specs)
    by_key: Dict[str, List[WriteSpec]] = {}
    for s in specs:
        by_key.setdefault(s.key, []).append(s)
    result: Dict[str, Set[str]] = {}
    for key, writes in by_key.items():
        ids = {w.wid for w in writes}
        maximal = {
            w.wid
            for w in writes
            if not any(w.wid in closure[other] for other in ids)
        }
        result[key] = maximal
    return result


def _delivery_events(
    nodes: Sequence[str], specs: Sequence[WriteSpec]
) -> Tuple[List[Tuple[str, str]], Dict[Tuple[str, str], Set[Tuple[str, str]]]]:
    specs = with_session_order(specs)
    events = [(s.wid, n) for s in specs for n in nodes]
    prereq: Dict[Tuple[str, str], Set[Tuple[str, str]]] = {
        e: set() for e in events
    }
    closure = transitive_closure(specs)
    for s in specs:
        for dep in s.deps:
            for n in nodes:
                prereq[(s.wid, n)].add((dep, n))
        for n in nodes:
            if n != s.node:
                prereq[(s.wid, n)].add((s.wid, s.node))  # issued at origin first
        # The origin must not observe undeclared writes before issuing:
        # anything outside the declared causal past is delivered afterwards.
        for other in specs:
            if other.wid != s.wid and other.wid not in closure[s.wid]:
                prereq[(other.wid, s.node)].add((s.wid, s.node))
    return events, prereq


def enumerate_legal_orders(
    nodes: Sequence[str],
    specs: Sequence[WriteSpec],
    limit: int = DEFAULT_LIMIT,
) -> List[Tuple[Tuple[str, str], ...]]:
    """All legal delivery sequences (topological sorts), capped by limit."""
    if len(nodes) > MAX_REPLICAS:
        raise ValueError("at most 4 replicas supported")
    if len(specs) > MAX_EVENTS:
        raise ValueError("at most 12 events supported")
    events, prereq = _delivery_events(nodes, specs)
    remaining = set(events)
    orders: List[Tuple[Tuple[str, str], ...]] = []
    sequence: List[Tuple[str, str]] = []

    def backtrack() -> None:
        if len(orders) >= limit:
            return
        if not remaining:
            orders.append(tuple(sequence))
            return
        delivered = set(events) - remaining
        for event in sorted(remaining):
            if prereq[event] <= delivered:
                remaining.discard(event)
                sequence.append(event)
                backtrack()
                sequence.pop()
                remaining.add(event)

    backtrack()
    return orders


def run_order(
    nodes: Sequence[str],
    specs: Sequence[WriteSpec],
    order: Sequence[Tuple[str, str]],
) -> Dict[str, Dict[str, List[str]]]:
    """Execute one delivery order on fresh replicas; return reads per node."""
    replicas = {n: Replica(n, 1) for n in nodes}
    by_id = {s.wid: s for s in specs}
    entries = {}
    for wid, node in order:
        spec = by_id[wid]
        if node == spec.node:
            entries[wid] = replicas[node].write(spec.key, spec.wid)
        else:
            entry = entries[wid]
            replica = replicas[node]
            if not replica.deliver_put(entry):
                raise AssertionError(
                    f"illegal order: {wid} undeliverable at {node}"
                )
    reads: Dict[str, Dict[str, List[str]]] = {}
    keys = {s.key for s in specs}
    for node in nodes:
        reads[node] = {key: replicas[node].read(key) for key in keys}
    return reads


@dataclass
class CheckResult:
    ok: bool
    checked: int = 0
    counterexample: Optional[List[Tuple[str, str]]] = None
    detail: str = ""


def check_scenario(
    nodes: Sequence[str],
    specs: Sequence[WriteSpec],
    limit: int = DEFAULT_LIMIT,
    verdict: Optional[Callable[[Dict[str, Dict[str, List[str]]]], bool]] = None,
) -> CheckResult:
    """Check every legal delivery order.  Default verdict: all replicas
    converge to the DAG-predicted causally maximal values."""
    expected = expected_maximal(specs)
    if verdict is None:
        def verdict(reads: Dict[str, Dict[str, List[str]]]) -> bool:
            for node_reads in reads.values():
                for key, want in expected.items():
                    if set(node_reads.get(key, [])) != want:
                        return False
            return True

    orders = enumerate_legal_orders(nodes, specs, limit)
    for order in orders:
        reads = run_order(nodes, specs, order)
        if not verdict(reads):
            short = minimize_counterexample(nodes, specs, order, verdict)
            return CheckResult(False, len(orders), short,
                               "verdict failed; minimized counterexample")
    return CheckResult(True, len(orders))


def minimize_counterexample(
    nodes: Sequence[str],
    specs: Sequence[WriteSpec],
    order: Sequence[Tuple[str, str]],
    verdict: Callable[[Dict[str, Dict[str, List[str]]]], bool],
) -> List[Tuple[str, str]]:
    """Greedily shrink a failing scenario; returns a failing delivery order
    of the reduced scenario (1-minimal w.r.t. write removal)."""
    current = list(specs)
    changed = True
    while changed:
        changed = False
        dependents = transitive_closure(current)
        for spec in list(current):
            if any(spec.wid in deps for deps in dependents.values()):
                continue  # keep writes others depend on
            trial = [s for s in current if s.wid != spec.wid]
            trial_orders = enumerate_legal_orders(nodes, trial)
            for trial_order in trial_orders:
                if not verdict(run_order(nodes, trial, trial_order)):
                    current = trial
                    order = trial_order
                    changed = True
                    break
            if changed:
                break
    return list(order)
