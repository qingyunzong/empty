"""Symbolic character predicates.

The path separator ``/`` is a dedicated automaton symbol and never appears
inside a character predicate.  Predicates only ever match *ordinary*
characters (any character except ``/``).
"""

from dataclasses import dataclass


class _Other:
    """Alphabet sentinel: any ordinary character not explicitly mentioned
    by any predicate of the current alphabet (a minterm representative)."""

    def __repr__(self):  # pragma: no cover - debugging aid
        return "<OTHER>"


OTHER = _Other()
SEPARATOR = "/"


@dataclass(frozen=True)
class CharClass:
    """A finite set of ordinary characters, or -- when ``negated`` -- its
    complement relative to all ordinary characters (never the separator)."""

    chars: frozenset
    negated: bool = False

    def __init__(self, chars=(), negated=False):
        chars = frozenset(chars)
        if SEPARATOR in chars:
            raise ValueError("the separator cannot appear in a character class")
        object.__setattr__(self, "chars", chars)
        object.__setattr__(self, "negated", bool(negated))

    def matches(self, ch):
        if ch == SEPARATOR:
            return False
        return (ch in self.chars) != self.negated

    def matches_symbol(self, sym):
        """Match against a minterm alphabet symbol (a concrete char, OTHER
        or the separator)."""
        if sym == SEPARATOR:
            return False
        if sym is OTHER:
            # OTHER stands for any ordinary character outside every
            # mentioned set, hence outside ``self.chars``.
            return self.negated
        return self.matches(sym)


ANY_CHAR = CharClass((), negated=True)


def alphabet_for(predicates):
    """Finite minterm alphabet for a set of predicates: every mentioned
    character, the OTHER sentinel and the separator."""
    mentioned = set()
    for pred in predicates:
        mentioned |= pred.chars
    return sorted(mentioned) + [OTHER, SEPARATOR]


def witness_char(excluded):
    """A concrete ordinary character not in ``excluded`` (instantiates OTHER)."""
    for codepoint in list(range(0x21, 0x7F)) + list(range(0xA0, 0x3000)):
        ch = chr(codepoint)
        if ch != SEPARATOR and ch not in excluded:
            return ch
    raise AssertionError("no witness character available")  # pragma: no cover
