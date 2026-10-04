"""Symbolic NFA and compilation of patterns.

The NFA alphabet is symbolic: transitions carry ``None`` (epsilon), the
separator ``"/"`` or a :class:`~pathpolicy.chars.CharClass` predicate.

``**`` is compiled with great care so that a zero-segment match never
produces an empty path segment (``a//b``) and never a leading or trailing
separator: every accepted string is a legal normalized path.
"""

from .chars import ANY_CHAR
from .pattern import STAR, STARSTAR, parse_pattern, segment_predicates

EPSILON = None


class NFA:
    def __init__(self):
        self.adj = [[]]
        self.start = 0
        self.accepts = set()

    def add_state(self):
        self.adj.append([])
        return len(self.adj) - 1

    def add(self, src, sym, dst):
        self.adj[src].append((sym, dst))


def _emit_plus(nfa, state, pred):
    """Append ``pred+`` (one or more ordinary chars); return the tail state."""
    mid = nfa.add_state()
    nfa.add(state, pred, mid)
    nfa.add(mid, pred, mid)
    return mid


def compile_pattern_nfa(text):
    """Compile a pattern to a symbolic NFA.

    The construction tracks, for every position between pattern segments,
    two kinds of boundary states:

    * ``zero``    -- no path segment has been consumed yet (only reachable
      through leading ``**`` segments that matched zero segments), so the
      next segment needs no separator;
    * ``regular`` -- at least one path segment has been consumed, so the
      next segment must be preceded by ``/``.

    This keeps ``**`` zero-segment matches from ever producing empty path
    segments (``a//b``) or stray leading/trailing separators.
    """
    segments = parse_pattern(text)
    nfa = NFA()
    zero = nfa.start
    regular = None
    has_zero = True
    for seg in segments:
        next_regular = nfa.add_state()
        next_zero = None
        if seg == STARSTAR:
            if regular is None:
                regular = nfa.add_state()
            if has_zero:
                # Zero segments: Z_i -> Z_{i+1}.  One or more: the first
                # segment carries no separator and lands in the regular
                # boundary of this position.
                next_zero = nfa.add_state()
                nfa.add(zero, EPSILON, next_zero)
                tail = _emit_plus(nfa, zero, ANY_CHAR)
                nfa.add(tail, EPSILON, regular)
            # Zero segments: R_i -> R_{i+1}.  More segments: each carries
            # its own leading separator and loops back to R_i.
            nfa.add(regular, EPSILON, next_regular)
            step = nfa.add_state()
            nfa.add(regular, "/", step)
            tail = _emit_plus(nfa, step, ANY_CHAR)
            nfa.add(tail, EPSILON, regular)
        else:
            if seg == STAR:
                # One non-empty segment: U+ from each boundary kind.
                if has_zero:
                    tail = _emit_plus(nfa, zero, ANY_CHAR)
                    nfa.add(tail, EPSILON, next_regular)
                if regular is not None:
                    step = nfa.add_state()
                    nfa.add(regular, "/", step)
                    tail = _emit_plus(nfa, step, ANY_CHAR)
                    nfa.add(tail, EPSILON, next_regular)
            else:
                preds = segment_predicates(seg)
                if has_zero:
                    cur = zero
                    for pred in preds:
                        nxt = nfa.add_state()
                        nfa.add(cur, pred, nxt)
                        cur = nxt
                    nfa.add(cur, EPSILON, next_regular)
                if regular is not None:
                    step = nfa.add_state()
                    nfa.add(regular, "/", step)
                    cur = step
                    for pred in preds:
                        nxt = nfa.add_state()
                        nfa.add(cur, pred, nxt)
                        cur = nxt
                    nfa.add(cur, EPSILON, next_regular)
        zero = next_zero
        has_zero = next_zero is not None
        regular = next_regular
    nfa.accepts.add(regular)
    if has_zero:
        # Only reachable when every pattern segment is ``**`` (or the
        # pattern is empty): the root path is matched with zero segments.
        nfa.accepts.add(zero)
    return nfa
