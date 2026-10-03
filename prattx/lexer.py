"""Tokenizer for prattx expressions."""

from dataclasses import dataclass

from .errors import ParseError

# Longest operators first so prefix matching is greedy.
OPERATORS = (
    "**", "==", "!=", "<=", ">=", "&&", "||",
    "+", "-", "*", "/", "%", "!", "<", ">", "=",
    "?", ":", "(", ")", "[", "]", ",",
)


@dataclass(frozen=True)
class Token:
    kind: str  # "int" | "ident" | "op" | "eof"
    text: str
    start: int
    end: int

    @property
    def span(self):
        return (self.start, self.end)


def lex(src):
    """Tokenize *src*; every returned token carries a span."""
    tokens = []
    i = 0
    n = len(src)
    while i < n:
        ch = src[i]
        if ch.isspace():
            i += 1
            continue
        if ch.isdigit():
            j = i + 1
            while j < n and src[j].isdigit():
                j += 1
            tokens.append(Token("int", src[i:j], i, j))
            i = j
            continue
        if ch.isalpha() or ch == "_":
            j = i + 1
            while j < n and (src[j].isalnum() or src[j] == "_"):
                j += 1
            tokens.append(Token("ident", src[i:j], i, j))
            i = j
            continue
        for op in OPERATORS:
            if src.startswith(op, i):
                tokens.append(Token("op", op, i, i + len(op)))
                i += len(op)
                break
        else:
            raise ParseError(got=ch, expected="token", span=(i, i + 1))
    tokens.append(Token("eof", "<eof>", n, n))
    return tokens
