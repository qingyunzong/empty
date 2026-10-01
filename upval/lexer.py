"""Tokenizer for the upval language."""

from .errors import ParseError

KEYWORDS = {"let", "fn", "if", "else"}
TWO_CHAR = {"==", "!=", "<=", ">="}
ONE_CHAR = set("+-*/%(){};=<>,")


class Token:
    __slots__ = ("kind", "text", "span")

    def __init__(self, kind, text, span):
        self.kind = kind  # "INT" | "IDENT" | "KW" | "OP" | "EOF"
        self.text = text
        self.span = span  # (start_line, start_col, end_line, end_col)

    def __repr__(self):
        return f"Token({self.kind}, {self.text!r})"


def tokenize(src):
    tokens = []
    i = 0
    line = 1
    col = 1
    n = len(src)

    def advance(count=1):
        nonlocal i, line, col
        for _ in range(count):
            if src[i] == "\n":
                line += 1
                col = 1
            else:
                col += 1
            i += 1

    while i < n:
        c = src[i]
        if c in " \t\r\n":
            advance()
            continue
        if c == "#" or (c == "/" and i + 1 < n and src[i + 1] == "/"):
            while i < n and src[i] != "\n":
                advance()
            continue
        start_line, start_col = line, col
        if c.isdigit():
            # integer literal
            j = i
            while i < n and src[i].isdigit():
                advance()
            tokens.append(Token("INT", src[j:i], (start_line, start_col, line, col)))
            continue
        if c.isalpha() or c == "_":
            j = i
            while i < n and (src[i].isalnum() or src[i] == "_"):
                advance()
            text = src[j:i]
            kind = "KW" if text in KEYWORDS else "IDENT"
            tokens.append(Token(kind, text, (start_line, start_col, line, col)))
            continue
        two = src[i:i + 2]
        if two in TWO_CHAR:
            advance(2)
            tokens.append(Token("OP", two, (start_line, start_col, line, col)))
            continue
        if c in ONE_CHAR:
            advance()
            tokens.append(Token("OP", c, (start_line, start_col, line, col)))
            continue
        raise ParseError(
            f"unexpected character {c!r}",
            span=(line, col, line, col + 1),
        )
    tokens.append(Token("EOF", "", (line, col, line, col)))
    return tokens
