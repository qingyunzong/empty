"""Hand-written lexer for the shadowc policy DSL.

Produces tokens with accurate 1-based line/col so that E_PARSE diagnostics
can point at the exact offending position.
"""

from __future__ import annotations

from dataclasses import dataclass

from .errors import PolicyError

KEYWORDS = frozenset(
    {
        "field",
        "action",
        "rule",
        "when",
        "then",
        "and",
        "or",
        "not",
        "in",
        "int",
        "string",
        "enum",
    }
)

_TWO_CHAR_PUNCT = ("==", "..")
_ONE_CHAR_PUNCT = ":,(){}"


@dataclass
class Token:
    kind: str  # "IDENT" | "INT" | "STRING" | "KEYWORD" | "PUNCT" | "EOF"
    value: str
    line: int
    col: int

    def describe(self) -> str:
        if self.kind == "EOF":
            return "end of input"
        return f"{self.kind.lower()} {self.value!r}"


def lex(source: str) -> list[Token]:
    tokens: list[Token] = []
    i = 0
    line = 1
    col = 1
    n = len(source)

    def error(message: str, err_line: int, err_col: int) -> None:
        raise PolicyError("E_PARSE", message, err_line, err_col)

    while i < n:
        ch = source[i]
        if ch in " \t\r":
            i += 1
            col += 1
            continue
        if ch == "\n":
            i += 1
            line += 1
            col = 1
            continue
        if ch == "#":
            while i < n and source[i] != "\n":
                i += 1
                col += 1
            continue
        if ch.isalpha() or ch == "_":
            j = i
            while j < n and (source[j].isalnum() or source[j] == "_"):
                j += 1
            word = source[i:j]
            kind = "KEYWORD" if word in KEYWORDS else "IDENT"
            tokens.append(Token(kind, word, line, col))
            col += j - i
            i = j
            continue
        if ch.isdigit() or (ch == "-" and i + 1 < n and source[i + 1].isdigit()):
            j = i + 1 if ch == "-" else i
            while j < n and source[j].isdigit():
                j += 1
            tokens.append(Token("INT", source[i:j], line, col))
            col += j - i
            i = j
            continue
        if ch == '"':
            start_line, start_col = line, col
            j = i + 1
            buf: list[str] = []
            while j < n and source[j] != '"':
                c2 = source[j]
                if c2 == "\n":
                    error("unterminated string literal", start_line, start_col)
                if c2 == "\x00":
                    error(
                        "NUL character is not allowed in string literals",
                        line,
                        col + (j - i),
                    )
                buf.append(c2)
                j += 1
            if j >= n:
                error("unterminated string literal", start_line, start_col)
            tokens.append(Token("STRING", "".join(buf), start_line, start_col))
            col += j - i + 1
            i = j + 1
            continue
        two = source[i : i + 2]
        if two in _TWO_CHAR_PUNCT:
            tokens.append(Token("PUNCT", two, line, col))
            i += 2
            col += 2
            continue
        if ch in _ONE_CHAR_PUNCT:
            tokens.append(Token("PUNCT", ch, line, col))
            i += 1
            col += 1
            continue
        error(f"unexpected character {ch!r}", line, col)
    tokens.append(Token("EOF", "", line, col))
    return tokens
