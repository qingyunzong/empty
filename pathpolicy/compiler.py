"""Compile patterns into symbolic NFAs, plus the legal-path language NFA.

A canonical path is ``/`` or a non-empty sequence of *units* ``/seg`` where
each segment is non-empty and not ``.`` or ``..``.  A pattern compiles to a
chain of unit matchers; ``**`` compiles to a loop matching zero or more
whole units.  The legal-path NFA accepts exactly the canonical paths, so
intersecting with it keeps complements relative to legal paths rather than
arbitrary strings.
"""
from .automata import NFA, CharSet
from .pattern import DOUBLESTAR, Lit, AnyChar, Star, CharClass

SLASH = CharSet({"/"})
NONSLASH = CharSet({"/"}, negated=True)
DOT = CharSet({"."})
NONDOT_NONSLASH = CharSet({"/", "."}, negated=True)


def _token_charset(tok):
    if isinstance(tok, Lit):
        return CharSet({tok.ch})
    if isinstance(tok, AnyChar):
        return NONSLASH
    if isinstance(tok, CharClass):
        if tok.negated:
            return CharSet(tok.chars | {"/"}, negated=True)
        return CharSet(tok.chars)
    raise TypeError(tok)


def _compile_segment(nfa, tokens, out):
    prev = out
    for tok in reversed(tokens):
        if isinstance(tok, Star):
            s = nfa.add_state()
            nfa.add_epsilon(s, prev)
            nfa.add_transition(s, NONSLASH, s)
            prev = s
        else:
            s = nfa.add_state()
            nfa.add_transition(s, _token_charset(tok), prev)
            prev = s
    if all(isinstance(t, Star) for t in tokens):
        entry = nfa.add_state()
        nfa.add_transition(entry, NONSLASH, prev)
        return entry
    return prev


def compile_pattern(pattern):
    """Compile a parsed Pattern into an NFA over canonical path strings."""
    nfa = NFA()
    segs = pattern.segments
    n = len(segs)
    final = nfa.add_state()
    nfa.accepting.add(final)
    if n == 0 or all(seg is DOUBLESTAR for seg in segs):
        nfa.add_transition(nfa.start, SLASH, final)
    if n == 0:
        return nfa
    entries = [None] * (n + 1)
    entries[n] = final
    for i in range(n - 1, -1, -1):
        seg = segs[i]
        nxt = entries[i + 1]
        if seg is DOUBLESTAR:
            loop = nfa.add_state()
            mid = nfa.add_state()
            body = nfa.add_state()
            nfa.add_epsilon(loop, nxt)
            nfa.add_transition(loop, SLASH, mid)
            nfa.add_transition(mid, NONSLASH, body)
            nfa.add_transition(body, NONSLASH, body)
            nfa.add_epsilon(body, loop)
            entries[i] = loop
        else:
            out = nfa.add_state()
            nfa.add_epsilon(out, nxt)
            entry = nfa.add_state()
            nfa.add_transition(entry, SLASH, _compile_segment(nfa, seg, out))
            entries[i] = entry
    nfa.add_epsilon(nfa.start, entries[0])
    return nfa


def legal_nfa():
    """NFA accepting exactly the canonical (normalized) paths."""
    nfa = NFA()
    root = nfa.add_state()
    nfa.accepting.add(root)
    nfa.add_transition(nfa.start, SLASH, root)
    seg_start = nfa.add_state()
    ok = nfa.add_state()
    nfa.accepting.add(ok)
    dot1 = nfa.add_state()
    dot2 = nfa.add_state()
    nfa.add_transition(root, NONDOT_NONSLASH, ok)
    nfa.add_transition(root, DOT, dot1)
    nfa.add_transition(ok, SLASH, seg_start)
    nfa.add_transition(seg_start, NONDOT_NONSLASH, ok)
    nfa.add_transition(seg_start, DOT, dot1)
    nfa.add_transition(dot1, NONDOT_NONSLASH, ok)
    nfa.add_transition(dot1, DOT, dot2)
    nfa.add_transition(dot2, NONDOT_NONSLASH, ok)
    nfa.add_transition(ok, NONSLASH, ok)
    return nfa
