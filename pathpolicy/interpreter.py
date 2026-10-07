"""Independent recursive pattern interpreter.

This matcher shares no code with the automaton pipeline: it walks pattern
segments and path segments recursively.  It is used to double-check every
difference witness produced by the automata and to cross-check automaton
behaviour on enumerated path sets.
"""
from functools import lru_cache

from .normalize import path_segments
from .pattern import parse_pattern, DOUBLESTAR, Lit, AnyChar, Star, CharClass


def match_tokens(tokens, s):
    """Match one segment pattern (token tuple) against one segment string."""
    @lru_cache(maxsize=None)
    def go(ti, pos):
        if ti == len(tokens):
            return pos == len(s)
        tok = tokens[ti]
        if isinstance(tok, Star):
            return any(go(ti + 1, k) for k in range(pos, len(s) + 1))
        if pos >= len(s):
            return False
        c = s[pos]
        if isinstance(tok, Lit):
            ok = c == tok.ch
        elif isinstance(tok, AnyChar):
            ok = c != "/"
        elif isinstance(tok, CharClass):
            ok = c != "/" and ((c in tok.chars) != tok.negated)
        else:
            raise TypeError(tok)
        return ok and go(ti + 1, pos + 1)

    return go(0, 0)


def match_pattern(pattern, path):
    """Match a pattern (string or Pattern) against a path.

    The path is normalized first; a '..' escaping the root raises
    PathEscapeError.
    """
    pat = parse_pattern(pattern) if isinstance(pattern, str) else pattern
    segs = path_segments(path)
    pats = pat.segments

    @lru_cache(maxsize=None)
    def go(pi, si):
        if pi == len(pats):
            return si == len(segs)
        if pats[pi] is DOUBLESTAR:
            return any(go(pi + 1, k) for k in range(si, len(segs) + 1))
        return (si < len(segs)
                and match_tokens(pats[pi], segs[si])
                and go(pi + 1, si + 1))

    return go(0, 0)


def match_policy(policy, path):
    """Whitelist minus blacklist: some allow matches, no deny matches."""
    return (any(match_pattern(p, path) for p in policy.allow)
            and not any(match_pattern(p, path) for p in policy.deny))
