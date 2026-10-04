"""Independent recursive interpreter.

Deliberately separate from the automaton engine: patterns are matched by
plain recursion over segments plus the ``re`` module.  Every verdict the
automaton produces for a concrete path is cross-checked here.
"""

import re

from .normalize import normalize_path, path_segments
from .pattern import STAR, STARSTAR, parse_pattern
from .ruleset import Minus, Pattern, Union


def _token_regex(token):
    kind = token[0]
    if kind == "lit":
        return re.escape(token[1])
    if kind == "any":
        return r"[^/]"
    if kind == "class":
        cc = token[1]
        body = "".join(re.escape(c) for c in sorted(cc.chars))
        # A complement class never matches the separator.
        return ("[^/" if cc.negated else "[") + body + "]"
    raise AssertionError("unknown token")  # pragma: no cover


def _segment_regex(segment):
    if segment == STAR:
        return re.compile(r"[^/]+")
    return re.compile("".join(_token_regex(t) for t in segment))


def _match_segments(pattern_segments, segments):
    if not pattern_segments:
        return not segments
    head, rest = pattern_segments[0], pattern_segments[1:]
    if head == STARSTAR:
        # Zero or more whole segments; the separators between the remaining
        # segments are untouched, so no empty segment can appear.
        return any(
            _match_segments(rest, segments[k:])
            for k in range(len(segments) + 1)
        )
    if not segments:
        return False
    if _segment_regex(head).fullmatch(segments[0]) is None:
        return False
    return _match_segments(rest, segments[1:])


def interp_match_normalized(expr, normalized):
    segments = path_segments(normalized)
    if isinstance(expr, Pattern):
        return _match_segments(parse_pattern(expr.text), segments)
    if isinstance(expr, Union):
        return any(interp_match_normalized(p, normalized) for p in expr.parts)
    if isinstance(expr, Minus):
        return interp_match_normalized(
            expr.left, normalized
        ) and not interp_match_normalized(expr.right, normalized)
    raise AssertionError("unknown expression")  # pragma: no cover


def interp_match(expr, path):
    return interp_match_normalized(expr, normalize_path(path))
