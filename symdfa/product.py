"""On-demand product exploration for symbolic DFA equivalence / inclusion.

The product space is explored lazily: for each visited pair of states the
overlapping outgoing intervals are split into segments on which both
machines have a constant successor.  Each segment is one product edge;
the search budget is charged per newly generated product edge.  No
character is ever enumerated individually.
"""

from __future__ import annotations

from collections import deque
from dataclasses import dataclass, field

from .dfa import CHAR_MIN, CHAR_MAX, DFA

SINK = None  # implicit reject sink, absorbing and non-accepting

MODE_EQUIVALENCE = "equivalence"
MODE_INCLUSION = "inclusion"

# statuses
EQUIVALENT = "equivalent"
NOT_EQUIVALENT = "not_equivalent"
INCLUDED = "included"
NOT_INCLUDED = "not_included"
UNKNOWN = "unknown"


def _out_intervals(dfa: DFA, state):
    if state is SINK:
        return ()
    return dfa.transitions.get(state, ())


def _step(dfa: DFA, state, char):
    if state is SINK:
        return SINK
    return dfa.step(state, char)


def _accept(dfa: DFA, state) -> bool:
    return state is not SINK and state in dfa.accepting


def is_mismatch(mode: str, dfa1: DFA, dfa2: DFA, p, q) -> bool:
    a1 = _accept(dfa1, p)
    a2 = _accept(dfa2, q)
    if mode == MODE_EQUIVALENCE:
        return a1 != a2
    if mode == MODE_INCLUSION:
        return a1 and not a2
    raise ValueError(f"unknown mode {mode!r}")


def partition_segments(dfa1: DFA, dfa2: DFA, p, q):
    """Split [CHAR_MIN, CHAR_MAX] into segments with constant successors.

    Returns a list of ``(lo, hi, dst1, dst2)`` covering the whole alphabet;
    ``dstX is None`` denotes the implicit reject sink.
    """
    cuts = {CHAR_MIN, CHAR_MAX + 1}
    for lo, hi, _ in _out_intervals(dfa1, p):
        cuts.add(lo)
        cuts.add(hi + 1)
    for lo, hi, _ in _out_intervals(dfa2, q):
        cuts.add(lo)
        cuts.add(hi + 1)
    points = sorted(cuts)
    segments = []
    for a, b in zip(points, points[1:]):
        lo, hi = a, b - 1
        segments.append((lo, hi, _step(dfa1, p, lo), _step(dfa2, q, lo)))
    return segments


@dataclass
class SearchState:
    """Resumable exploration state (the frontier plus closed set)."""

    mode: str
    frontier: deque = field(default_factory=deque)  # items: (pair, path)
    visited: set = field(default_factory=set)
    items: dict = field(default_factory=dict)  # pair -> segments
    edges_used: int = 0


@dataclass
class CheckResult:
    status: str
    mode: str
    witness: tuple | None = None  # minimal counterexample, if any
    items: dict | None = None  # pair -> segments, when a relation was proved
    state: SearchState | None = None  # resumable state when status == UNKNOWN
    edges_used: int = 0


def check(dfa1: DFA, dfa2: DFA, mode: str = MODE_EQUIVALENCE,
          budget: int | None = None, resume: SearchState | None = None,
          cache: dict | None = None) -> CheckResult:
    """Explore the product of ``dfa1`` and ``dfa2``.

    ``budget`` limits how many *new* product edges this call may generate
    (edges served from ``cache`` are free).  On exhaustion the result is
    UNKNOWN and carries a SearchState that can be passed back as ``resume``
    to continue exactly where the exploration stopped.

    ``cache`` maps a product pair to its still-valid segments (see
    ``proof.revalidate``); cached pairs are not re-expanded.
    """
    if resume is None:
        st = SearchState(mode=mode)
        st.frontier.append(((dfa1.start, dfa2.start), ()))
    else:
        st = resume
        if st.mode != mode:
            raise ValueError("cannot resume a search with a different mode")
    cache = cache or {}

    while st.frontier:
        pair, path = st.frontier.popleft()
        if pair in st.visited:
            continue
        p, q = pair
        if is_mismatch(mode, dfa1, dfa2, p, q):
            status = NOT_EQUIVALENT if mode == MODE_EQUIVALENCE else NOT_INCLUDED
            return CheckResult(status=status, mode=mode, witness=path,
                               edges_used=st.edges_used)
        if pair in cache:
            segments = cache[pair]
            cost = 0
        else:
            segments = partition_segments(dfa1, dfa2, p, q)
            cost = len(segments)
        if budget is not None and cost > 0 and st.edges_used + cost > budget:
            # Not enough budget for this pair: push it back and stop.
            st.frontier.appendleft((pair, path))
            return CheckResult(status=UNKNOWN, mode=mode, state=st,
                               edges_used=st.edges_used)
        st.visited.add(pair)
        st.items[pair] = segments
        st.edges_used += cost
        for lo, hi, d1, d2 in segments:
            nxt = (d1, d2)
            if nxt == (SINK, SINK):
                continue  # trivially closed, both reject everything
            if nxt not in st.visited:
                # segments are generated in ascending order, so BFS pops
                # candidates in (length, lexicographic) order of their word
                st.frontier.append((nxt, path + (lo,)))

    status = EQUIVALENT if mode == MODE_EQUIVALENCE else INCLUDED
    return CheckResult(status=status, mode=mode, items=st.items,
                       edges_used=st.edges_used)


def check_equivalence(dfa1, dfa2, budget=None, resume=None, cache=None):
    return check(dfa1, dfa2, MODE_EQUIVALENCE, budget, resume, cache)


def check_inclusion(dfa1, dfa2, budget=None, resume=None, cache=None):
    return check(dfa1, dfa2, MODE_INCLUSION, budget, resume, cache)
