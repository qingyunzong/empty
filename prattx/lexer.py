"""Tokenizer for prattx expressions."""

from dataclasses import dataclass

from .errors import ParseError

MULTI_OPS = ("**", "==", "!=", "<=", ">=", "&&", "||")
SINGLE_OPS = set("+-*/%!<>=?:()[],")


@dataclass(frozen=True)
class Token:
    kind: str  # "int" | "ident" | "op" | "eof"
    text: str
    start: int
    end: int


def lex(source):
    """Split *source* into tokens. Raises ParseError on bad characters."""
    tokens = []
    i = 0
    n = len(source)
    while i < n:
        ch = source[i]
        if ch.isspace():
            i += 1
        elif ch.isdigit():
            j = i + 1
            while j < n and source[j].isdigit():
                j += 1
            tokens.append(Token("int", source[i:j], i, j))
            i = j
        elif ch.isalpha() or ch == "_":
            j = i + 1
            while j < n and (source[j].isalnum() or source[j] == "_"):
                j += 1
            tokens.append(Token("ident", source[i:j], i, j))
            i = j
        elif source[i : i + 2] in MULTI_OPS:
            tokens.append(Token("op", source[i : i + 2], i, i + 2))
            i += 2
        elif ch in SINGLE_OPS:
            tokens.append(Token("op", ch, i, i + 1))
            i += 1
        else:
            raise ParseError(got=ch, expected="token", span=(i, i + 1))
    tokens.append(Token("eof", "EOF", n, n))
    return tokens
