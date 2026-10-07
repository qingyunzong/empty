"""Pattern parsing: wildcards, character classes and edit-distance marker.

Syntax (matched against Unicode code points of normalized terms):
    *        any sequence of code points, including the empty sequence
    ?        exactly one code point
    [abc]    one code point from the set
    [a-z]    inclusive code-point range (endpoints included)
    [^abc]   negated class
    \\x       literal x (escape)
    {~d}     trailing edit-distance marker, d in 0..2 ({~} means {~1})

Parsing is pure: an invalid pattern raises PatternError and produces no
partial state, so rejection is atomic.
"""

from __future__ import annotations

import re
from dataclasses import dataclass

from .normalize import CURRENT_NORMALIZATION_VERSION, normalize

MAX_EDIT_DISTANCE = 2


class PatternError(ValueError):
    """Raised when a pattern is syntactically or semantically invalid."""


@dataclass(frozen=True)
class Lit:
    ch: str

    def matches(self, c):
        return c == self.ch

    def describe(self):
        return self.ch


@dataclass(frozen=True)
class AnyChar:
    def matches(self, c):
        return True

    def describe(self):
        return "?"


@dataclass(frozen=True)
class CharClass:
    chars: frozenset
    negated: bool = False

    def matches(self, c):
        return (c in self.chars) != self.negated

    def describe(self):
        body = "".join(sorted(self.chars))
        return "[{}{}]".format("^" if self.negated else "", body)


@dataclass(frozen=True)
class Star:
    def matches(self, c):
        return True

    def describe(self):
        return "*"


@dataclass(frozen=True)
class CompiledPattern:
    source: str
    elements: tuple
    d: int


_EDIT_MARKER = re.compile(r"\{~(\d*)\}$")


def _norm_char(ch, version):
    normed = normalize(ch, version)
    if len(normed) != 1:
        raise PatternError(
            f"normalization of {ch!r} is not a single code point: {normed!r}"
        )
    return normed


def _parse_class(text, i, version):
    # text[i] == '['; returns (CharClass, index after ']').
    j = i + 1
    negated = False
    if j < len(text) and text[j] == "^":
        negated = True
        j += 1
    chars = set()
    first = True

    def read_char(k):
        if text[k] == "\\":
            k += 1
            if k >= len(text):
                raise PatternError("dangling escape in character class")
        return text[k], k + 1

    while True:
        if j >= len(text):
            raise PatternError("unterminated character class")
        if text[j] == "]" and not first:
            j += 1
            break
        first = False
        lo, j = read_char(j)
        if j < len(text) and text[j] == "-" and j + 1 < len(text) and text[j + 1] != "]":
            hi, j = read_char(j + 1)
            lo_n = _norm_char(lo, version)
            hi_n = _norm_char(hi, version)
            if ord(lo_n) > ord(hi_n):
                raise PatternError(f"invalid range {lo!r}-{hi!r}: endpoints out of order")
            for cp in range(ord(lo_n), ord(hi_n) + 1):
                chars.add(chr(cp))
        else:
            chars.add(_norm_char(lo, version))
    if not chars:
        raise PatternError("empty character class")
    return CharClass(frozenset(chars), negated), j


def parse_pattern(source, normalization_version=CURRENT_NORMALIZATION_VERSION):
    if not isinstance(source, str):
        raise PatternError("pattern must be a string")
    text = source
    d = 0
    marker = _EDIT_MARKER.search(text)
    if marker:
        d = int(marker.group(1)) if marker.group(1) else 1
        if d > MAX_EDIT_DISTANCE:
            raise PatternError(
                f"edit distance {d} exceeds maximum {MAX_EDIT_DISTANCE}"
            )
        text = text[: marker.start()]

    elements = []
    literal_buf = []

    def flush_literals():
        # Normalize each maximal run of literal characters as a whole so
        # that canonical composition (e.g. "e" + U+0301 -> "é") happens
        # exactly as it does for indexed terms.
        if literal_buf:
            normed = normalize("".join(literal_buf), normalization_version)
            elements.extend(Lit(ch) for ch in normed)
            literal_buf.clear()

    i = 0
    while i < len(text):
        c = text[i]
        if c == "\\":
            i += 1
            if i >= len(text):
                raise PatternError("dangling escape at end of pattern")
            literal_buf.append(text[i])
            i += 1
        elif c == "*":
            flush_literals()
            elements.append(Star())
            i += 1
        elif c == "?":
            flush_literals()
            elements.append(AnyChar())
            i += 1
        elif c == "[":
            flush_literals()
            cls, i = _parse_class(text, i, normalization_version)
            elements.append(cls)
        elif c == "{" and text[i + 1 : i + 2] == "~":
            raise PatternError("edit-distance marker is only allowed at pattern end")
        else:
            literal_buf.append(c)
            i += 1
    flush_literals()
    return CompiledPattern(source=source, elements=tuple(elements), d=d)
