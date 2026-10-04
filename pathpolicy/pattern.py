"""Pattern syntax.

A pattern is a ``/``-separated list of segments.  A segment is either

* ``**``            -- matches zero or more whole segments
* ``*``             -- matches exactly one non-empty segment
* a literal segment -- a sequence of tokens, where a token is a literal
  character, ``?`` (any single ordinary character) or a character class
  ``[abc]``, ``[a-z]``, ``[^abc]`` / ``[!abc]`` (a complement class never
  matches the separator).  ``\\`` escapes the next character.

The empty pattern ``""`` matches only the root (empty) path.
"""

from .chars import ANY_CHAR, CharClass

STAR = "*"
STARSTAR = "**"


class PatternError(ValueError):
    """Raised for syntactically invalid patterns."""


def parse_pattern(text):
    """Parse a pattern into a list of segments.

    Each segment is either the string ``"*"``, the string ``"**"`` or a
    tuple of tokens ``("lit", ch)`` / ``("any",)`` / ``("class", CharClass)``.
    """
    if not isinstance(text, str):
        raise PatternError("pattern must be a string")
    if text == "":
        return []
    if text.startswith("/") or text.endswith("/") or "//" in text:
        raise PatternError(
            "pattern must be relative with single separators: %r" % text
        )
    segments = []
    for raw in text.split("/"):
        if raw == STARSTAR:
            segments.append(STARSTAR)
        elif raw == STAR:
            segments.append(STAR)
        else:
            segments.append(tuple(_parse_segment(raw)))
    return segments


def _parse_segment(raw):
    tokens = []
    i = 0
    while i < len(raw):
        c = raw[i]
        if c == "*":
            raise PatternError("'*' must occupy a whole segment")
        if c == "?":
            tokens.append(("any",))
            i += 1
        elif c == "[":
            cc, i = _parse_class(raw, i)
            tokens.append(("class", cc))
        elif c == "\\":
            i += 1
            if i >= len(raw):
                raise PatternError("dangling escape")
            tokens.append(("lit", raw[i]))
            i += 1
        elif c == "]":
            raise PatternError("unmatched ']'")
        else:
            tokens.append(("lit", c))
            i += 1
    if not tokens:
        raise PatternError("empty segment")
    return tokens


def _parse_class(raw, i):
    j = i + 1
    negated = False
    if j < len(raw) and raw[j] in "^!":
        negated = True
        j += 1
    chars = set()
    first = True
    while True:
        if j >= len(raw):
            raise PatternError("unterminated '['")
        c = raw[j]
        if c == "]" and not first:
            j += 1
            break
        first = False
        if c == "\\":
            j += 1
            if j >= len(raw):
                raise PatternError("dangling escape in character class")
            c = raw[j]
        if c == "/":
            raise PatternError("the separator is not allowed in a character class")
        if j + 2 < len(raw) and raw[j + 1] == "-" and raw[j + 2] != "]":
            hi = raw[j + 2]
            if hi == "/":
                raise PatternError(
                    "the separator is not allowed in a character class"
                )
            if ord(hi) < ord(c):
                raise PatternError("invalid range %r-%r" % (c, hi))
            chars.update(chr(k) for k in range(ord(c), ord(hi) + 1))
            j += 3
        else:
            chars.add(c)
            j += 1
    if not chars:
        raise PatternError("empty character class")
    return CharClass(chars, negated), j


def segment_predicates(segment):
    """Character predicates of a literal segment, in order."""
    preds = []
    for token in segment:
        kind = token[0]
        if kind == "lit":
            preds.append(CharClass((token[1],)))
        elif kind == "any":
            preds.append(ANY_CHAR)
        elif kind == "class":
            preds.append(token[1])
        else:  # pragma: no cover - defensive
            raise AssertionError("unknown token %r" % (token,))
    return preds


def pattern_predicates(segments):
    """All character predicates used by a parsed pattern."""
    preds = []
    for seg in segments:
        if seg == STAR or seg == STARSTAR:
            preds.append(ANY_CHAR)
        else:
            preds.extend(segment_predicates(seg))
    return preds
