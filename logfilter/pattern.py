"""Pattern parsing and compilation.

Grammar (matching is over Unicode code points):

    literal     any character except the metacharacters below
    \\x          escaped literal (works for any character x)
    ?           exactly one code point
    *           any sequence of code points, including the empty string
    [abc]       character class; ranges like [a-z]; leading ! or ^ negates;
                '-' is literal at the ends or when escaped
    ~d          suffix: allow up to d edits (0 <= d <= 2); '~' alone means 1

Edit distance applies to the whole match: a word matches iff some string
accepted by the wildcard part of the pattern is within d Levenshtein edits
of the word.  Anything malformed raises PatternError before any index or
search state is touched (atomic rejection).
"""

from __future__ import annotations

from dataclasses import dataclass, field

from .normalize import NormalizationRules

MAX_EDITS = 2

LITERAL = "literal"
ANY = "any"
CLASS = "class"
STAR = "star"


class PatternError(ValueError):
    """Raised when a pattern is malformed.  Nothing is mutated."""


@dataclass(frozen=True)
class Token:
    kind: str
    char: str = ""                      # literal
    chars: frozenset = frozenset()      # class: single characters
    ranges: tuple = ()                  # class: ((lo, hi), ...) code-point ranges
    negated: bool = False               # class
    source: str = ""

    def matches(self, ch: str) -> bool:
        if self.kind == LITERAL:
            return ch == self.char
        if self.kind in (ANY, STAR):
            return True
        hit = ch in self.chars
        if not hit:
            for lo, hi in self.ranges:
                if lo <= ch <= hi:
                    hit = True
                    break
        return (not hit) if self.negated else hit


@dataclass(frozen=True)
class CompiledPattern:
    tokens: tuple
    edits: int
    source: str
    closures: tuple  # closures[i] = frozenset of NFA states reachable by epsilon from i

    @property
    def accept(self) -> int:
        return len(self.tokens)


def _split_edits(source: str) -> tuple[str, int]:
    body = []
    tilde_at = None
    i = 0
    while i < len(source):
        c = source[i]
        if c == "\\" and i + 1 < len(source):
            i += 2
            continue
        if c == "~":
            if tilde_at is not None:
                raise PatternError("multiple unescaped '~' in pattern")
            tilde_at = i
        i += 1
    if tilde_at is None:
        return source, 0
    suffix = source[tilde_at + 1:]
    body = source[:tilde_at]
    if suffix == "":
        return body, 1
    if not suffix.isdigit():
        raise PatternError(f"invalid edit-distance suffix ~{suffix}")
    edits = int(suffix)
    if edits > MAX_EDITS:
        raise PatternError(
            f"edit distance {edits} exceeds maximum {MAX_EDITS}"
        )
    return body, edits


def _literal_tokens(ch: str, rules: NormalizationRules) -> list:
    norm = rules.normalize(ch)
    return [Token(LITERAL, char=c, source=ch) for c in norm]


def _norm_class_char(ch: str, rules: NormalizationRules) -> str:
    norm = rules.normalize(ch)
    if len(norm) != 1:
        raise PatternError(
            f"character {ch!r} normalizes to {norm!r}; not allowed in a class"
        )
    return norm


def _parse_class(text: str, start: int, rules: NormalizationRules) -> tuple[Token, int]:
    i = start + 1
    negated = False
    if i < len(text) and text[i] in "!^":
        negated = True
        i += 1
    singles = []
    ranges = []
    items = []  # raw chars in order, escapes resolved
    while True:
        if i >= len(text):
            raise PatternError("unterminated character class")
        c = text[i]
        if c == "]" and items:
            i += 1
            break
        if c == "\\":
            i += 1
            if i >= len(text):
                raise PatternError("dangling escape in character class")
            items.append(text[i])
            i += 1
            continue
        items.append(c)
        i += 1
    if not items:
        raise PatternError("empty character class")
    singles_out: list[str] = []
    ranges_out: list[tuple[str, str]] = []
    k = 0
    while k < len(items):
        c = items[k]
        if c == "-" and singles_out and k + 1 < len(items):
            lo_raw = singles_out.pop()
            hi_raw = items[k + 1]
            lo = _norm_class_char(lo_raw, rules)
            hi = _norm_class_char(hi_raw, rules)
            if lo > hi:
                raise PatternError(f"invalid range {lo_raw}-{hi_raw}")
            ranges_out.append((lo, hi))
            k += 2
            continue
        singles_out.append(_norm_class_char(c, rules))
        k += 1
    return (
        Token(
            CLASS,
            chars=frozenset(singles_out),
            ranges=tuple(ranges_out),
            negated=negated,
            source=text[start:i],
        ),
        i,
    )


def parse_pattern(
    source: str, rules: NormalizationRules = NormalizationRules()
) -> CompiledPattern:
    """Parse and compile a pattern.  Raises PatternError on any malformed
    input; no external state is touched (atomic rejection)."""
    if not isinstance(source, str):
        raise PatternError("pattern must be a string")
    body, edits = _split_edits(source)
    tokens: list[Token] = []
    i = 0
    while i < len(body):
        c = body[i]
        if c == "\\":
            i += 1
            if i >= len(body):
                raise PatternError("dangling escape at end of pattern")
            tokens.extend(_literal_tokens(body[i], rules))
            i += 1
        elif c == "*":
            tokens.append(Token(STAR, source="*"))
            i += 1
        elif c == "?":
            tokens.append(Token(ANY, source="?"))
            i += 1
        elif c == "[":
            token, i = _parse_class(body, i, rules)
            tokens.append(token)
        elif c == "]":
            raise PatternError("unmatched ']'")
        elif c == "~":
            raise PatternError("unescaped '~' (use \\~ for a literal tilde)")
        else:
            tokens.extend(_literal_tokens(c, rules))
            i += 1
    n = len(tokens)
    closures = [frozenset() for _ in range(n + 1)]
    closures[n] = frozenset({n})
    for state in range(n - 1, -1, -1):
        if tokens[state].kind == STAR:
            closures[state] = frozenset({state}) | closures[state + 1]
        else:
            closures[state] = frozenset({state})
    return CompiledPattern(
        tokens=tuple(tokens), edits=edits, source=source, closures=tuple(closures)
    )
