"""Pattern language parser.

Grammar (paths are normalized before matching, so patterns are normalized
the same way: empty and ``.`` segments are dropped, ``..`` is rejected)::

    pattern   := segment ("/" segment)*
    segment   := "**" | item*
    item      := literal | "*" | "?" | class | escape
    escape    := "\\" <any char except "/">
    class     := "[" ["^" | "!"] classitem+ "]"
    classitem := char | char "-" char | escape

Semantics:
  - literal characters match themselves (never the separator),
  - ``*`` matches a run of non-separator characters inside one segment,
  - ``?`` matches exactly one non-separator character,
  - ``[...]`` matches one character in the set; ``[^...]`` / ``[!...]``
    matches one character outside the set but still never the separator,
  - ``**`` (only as a whole segment) matches zero or more whole segments.
"""

from dataclasses import dataclass


class PatternError(ValueError):
    """Raised for malformed patterns."""


@dataclass(frozen=True)
class Lit:
    ch: str


@dataclass(frozen=True)
class AnyChar:
    pass


@dataclass(frozen=True)
class Star:
    pass


@dataclass(frozen=True)
class CharClass:
    chars: frozenset
    negated: bool = False


class DoubleStar:
    _instance = None

    def __new__(cls):
        if cls._instance is None:
            cls._instance = super().__new__(cls)
        return cls._instance

    def __repr__(self):
        return "DOUBLESTAR"


DOUBLESTAR = DoubleStar()


@dataclass(frozen=True)
class Pattern:
    segments: tuple

    def __str__(self):
        return pattern_to_string(self)


def parse_pattern(text):
    """Parse *text* into a Pattern, normalizing segments like a path."""
    if not isinstance(text, str):
        raise PatternError("pattern must be a string, got %r" % type(text).__name__)
    raw = []
    for part in text.split("/"):
        if part == "" or part == ".":
            continue
        if part == "..":
            raise PatternError("'..' is not allowed in patterns: %r" % (text,))
        raw.append(part)
    segments = []
    for seg in raw:
        tokens = tuple(_parse_segment(seg))
        if tokens == (Star(), Star()):
            segments.append(DOUBLESTAR)
            continue
        for prev, cur in zip(tokens, tokens[1:]):
            if isinstance(prev, Star) and isinstance(cur, Star):
                raise PatternError(
                    "'**' is only allowed as a whole segment: %r" % (seg,))
        segments.append(tokens)
    return Pattern(tuple(segments))


def _parse_segment(seg):
    tokens = []
    i = 0
    n = len(seg)
    while i < n:
        c = seg[i]
        if c == "\\":
            if i + 1 >= n:
                raise PatternError("trailing backslash in %r" % (seg,))
            ch = seg[i + 1]
            if ch == "/":
                raise PatternError("the separator '/' cannot be escaped")
            tokens.append(Lit(ch))
            i += 2
        elif c == "*":
            tokens.append(Star())
            i += 1
        elif c == "?":
            tokens.append(AnyChar())
            i += 1
        elif c == "[":
            tok, i = _parse_class(seg, i)
            tokens.append(tok)
        else:
            tokens.append(Lit(c))
            i += 1
    return tokens


def _parse_class(seg, i):
    j = i + 1
    negated = False
    if j < len(seg) and seg[j] in "^!":
        negated = True
        j += 1
    chars = set()
    first = True
    while True:
        if j >= len(seg):
            raise PatternError("unterminated character class in %r" % (seg,))
        c = seg[j]
        if c == "]" and not first:
            j += 1
            if not chars:
                raise PatternError("empty character class in %r" % (seg,))
            return CharClass(frozenset(chars), negated), j
        first = False
        if c == "\\":
            if j + 1 >= len(seg):
                raise PatternError("trailing backslash in class %r" % (seg,))
            lo = seg[j + 1]
            j += 2
        else:
            lo = c
            j += 1
        if lo == "/":
            raise PatternError("the separator '/' is not allowed in a class")
        if j + 1 < len(seg) and seg[j] == "-" and seg[j + 1] != "]":
            hi = seg[j + 1]
            j += 2
            if hi == "\\":
                if j >= len(seg):
                    raise PatternError("trailing backslash in class %r" % (seg,))
                hi = seg[j]
                j += 1
            if ord(hi) < ord(lo):
                raise PatternError("bad range %r-%r" % (lo, hi))
            if ord(lo) <= ord("/") <= ord(hi):
                raise PatternError("range %r-%r would include the separator" % (lo, hi))
            chars.update(chr(k) for k in range(ord(lo), ord(hi) + 1))
        else:
            chars.add(lo)


def token_to_string(tok):
    if isinstance(tok, Lit):
        if tok.ch in "*?[]\\":
            return "\\" + tok.ch
        return tok.ch
    if isinstance(tok, AnyChar):
        return "?"
    if isinstance(tok, Star):
        return "*"
    if isinstance(tok, CharClass):
        body = "".join(
            ("\\" + c) if c in "\\]-" else c for c in sorted(tok.chars))
        return "[" + ("^" if tok.negated else "") + body + "]"
    raise TypeError(tok)


def pattern_to_string(pattern):
    parts = []
    for seg in pattern.segments:
        if seg is DOUBLESTAR:
            parts.append("**")
        else:
            parts.append("".join(token_to_string(t) for t in seg))
    return "/".join(parts)
