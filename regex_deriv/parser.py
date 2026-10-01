"""Regex string parser producing a raw (unnormalized) AST of tuples.

Grammar (loosest binding last):

    union   := inter ('|' inter)*
    inter   := concat ('&' concat)*
    concat  := postfix*
    postfix := prefix ('*' | '+' | '?')*
    prefix  := '~' prefix | atom
    atom    := '(' union ')' | class | '.' | '∅' | 'ε' | escape | literal
    class   := '[' '^'? item* ']'      item := char | char '-' char

  ∅  (U+2205)  empty language          ε  (U+03B5)  empty string
  |  union      &  intersection        ~  complement (vs. the alphabet)
  *  Kleene star   +  one-or-more      ?  optional
  .  any character of the alphabet (requires an alphabet)
  [a-z]  character class;  [^a-z]  negated class (requires an alphabet)
  \\ escapes any metacharacter; \\n \\t \\r \\0 are control characters.

An empty pattern (or empty group) denotes ε.
"""
from __future__ import annotations

ESCAPES = {"n": "\n", "t": "\t", "r": "\r", "0": "\0"}
META = set("|&*+?()[]~.\\")


def parse(pattern, alphabet=None):
    """Parse `pattern` into a raw AST. `alphabet` (Alphabet) is required
    when the pattern uses '.' or a negated character class."""
    p = _Parser(pattern, alphabet)
    raw = p.parse_union()
    if p.peek() != "":
        raise SyntaxError(f"unexpected {p.peek()!r} at position {p.i}")
    return raw


def subtract_ranges(base, taken):
    """base minus taken (both lists of (lo, hi)); result list of (lo, hi)."""
    out = []
    for lo, hi in base:
        cur = lo
        for tlo, thi in sorted(taken):
            if thi < cur:
                continue
            if tlo > hi:
                break
            if tlo > cur:
                out.append((cur, tlo - 1))
            cur = max(cur, thi + 1)
            if cur > hi:
                break
        if cur <= hi:
            out.append((cur, hi))
    return out


class _Parser:
    def __init__(self, s, alphabet):
        self.s = s
        self.i = 0
        self.alphabet = alphabet

    def peek(self):
        return self.s[self.i] if self.i < len(self.s) else ""

    def next(self):
        c = self.s[self.i]
        self.i += 1
        return c

    def parse_union(self):
        parts = [self.parse_inter()]
        while self.peek() == "|":
            self.i += 1
            parts.append(self.parse_inter())
        return parts[0] if len(parts) == 1 else ("union", *parts)

    def parse_inter(self):
        parts = [self.parse_concat()]
        while self.peek() == "&":
            self.i += 1
            parts.append(self.parse_concat())
        return parts[0] if len(parts) == 1 else ("inter", *parts)

    def parse_concat(self):
        parts = []
        while self.peek() not in ("", "|", "&", ")"):
            parts.append(self.parse_postfix())
        if not parts:
            return ("eps",)
        if len(parts) == 1:
            return parts[0]
        return ("concat", *parts)

    def parse_postfix(self):
        x = self.parse_prefix()
        while self.peek() in ("*", "+", "?"):
            c = self.next()
            if c == "*":
                x = ("star", x)
            elif c == "+":
                x = ("concat", x, ("star", x))
            else:
                x = ("union", x, ("eps",))
        return x

    def parse_prefix(self):
        if self.peek() == "~":
            self.i += 1
            return ("compl", self.parse_prefix())
        return self.parse_atom()

    def parse_escape(self):
        if self.i >= len(self.s):
            raise SyntaxError("trailing backslash")
        c = self.s[self.i]
        self.i += 1
        return ESCAPES.get(c, c)

    def parse_atom(self):
        c = self.peek()
        if c == "(":
            self.i += 1
            r = self.parse_union()
            if self.peek() != ")":
                raise SyntaxError(f"missing ')' at position {self.i}")
            self.i += 1
            return r
        if c == "[":
            return self.parse_class()
        if c == "∅":
            self.i += 1
            return ("empty",)
        if c == "ε":
            self.i += 1
            return ("eps",)
        if c == ".":
            self.i += 1
            if self.alphabet is None:
                raise SyntaxError("'.' requires an explicit alphabet")
            return ("union", *[("char", lo, hi)
                               for lo, hi in self.alphabet.intervals()])
        if c == "\\":
            self.i += 1
            ch = self.parse_escape()
            return ("char", ord(ch), ord(ch))
        if c == "":
            raise SyntaxError("unexpected end of pattern")
        if c in META:
            raise SyntaxError(f"unexpected {c!r} at position {self.i}")
        self.i += 1
        return ("char", ord(c), ord(c))

    def parse_class(self):
        self.i += 1  # consume '['
        negated = False
        if self.peek() == "^":
            negated = True
            self.i += 1
        ranges = []
        while True:
            c = self.peek()
            if c == "":
                raise SyntaxError("unterminated '['")
            if c == "]":
                self.i += 1
                break
            if c == "\\":
                self.i += 1
                lo = self.parse_escape()
            else:
                lo = self.next()
            if self.peek() == "-" and self.s[self.i + 1:self.i + 2] not in ("]", ""):
                self.i += 1
                if self.peek() == "\\":
                    self.i += 1
                    hi = self.parse_escape()
                else:
                    hi = self.next()
                if ord(lo) > ord(hi):
                    raise SyntaxError(f"bad range {lo!r}-{hi!r}")
                ranges.append((ord(lo), ord(hi)))
            else:
                ranges.append((ord(lo), ord(lo)))
        if not negated:
            if not ranges:
                return ("empty",)
            return ("union", *[("char", lo, hi) for lo, hi in ranges])
        if self.alphabet is None:
            raise SyntaxError("negated class requires an explicit alphabet")
        comp = subtract_ranges(self.alphabet.intervals(), ranges)
        if not comp:
            return ("empty",)
        return ("union", *[("char", lo, hi) for lo, hi in comp])
