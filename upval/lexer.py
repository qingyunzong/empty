"""Tokenizer for the upval language."""

from .errors import LexError

KEYWORDS = {
    "let": "LET",
    "fn": "FN",
    "return": "RETURN",
    "if": "IF",
    "else": "ELSE",
}

SINGLE = {
    "(": "LPAREN",
    ")": "RPAREN",
    "{": "LBRACE",
    "}": "RBRACE",
    ";": "SEMI",
    ",": "COMMA",
    "+": "PLUS",
    "-": "MINUS",
    "*": "STAR",
    "/": "SLASH",
    "%": "PERCENT",
    "=": "ASSIGN",
    "<": "LT",
    ">": "GT",
}

DOUBLE = {
    "==": "EQ",
    "!=": "NE",
    "<=": "LE",
    ">=": "GE",
}


class Token:
    __slots__ = ("kind", "text", "start", "end")

    def __init__(self, kind, text, start, end):
        self.kind = kind
        self.text = text
        self.start = start
        self.end = end

    def __repr__(self):
        return f"Token({self.kind}, {self.text!r}, {self.start}, {self.end})"


def tokenize(src):
    tokens = []
    i = 0
    n = len(src)
    while i < n:
        ch = src[i]
        if ch in " \t\r\n":
            i += 1
            continue
        if ch == "#":
            while i < n and src[i] != "\n":
                i += 1
            continue
        if ch.isdigit():
            j = i
            while j < n and src[j].isdigit():
                j += 1
            tokens.append(Token("INT", src[i:j], i, j))
            i = j
            continue
        if ch.isalpha() or ch == "_":
            j = i
            while j < n and (src[j].isalnum() or src[j] == "_"):
                j += 1
            word = src[i:j]
            tokens.append(Token(KEYWORDS.get(word, "IDENT"), word, i, j))
            i = j
            continue
        two = src[i : i + 2]
        if two in DOUBLE:
            tokens.append(Token(DOUBLE[two], two, i, i + 2))
            i += 2
            continue
        if ch == "!":
            raise LexError(span=(i, i + 1), message="unexpected character '!'")
        if ch in SINGLE:
            tokens.append(Token(SINGLE[ch], ch, i, i + 1))
            i += 1
            continue
        raise LexError(span=(i, i + 1), message=f"unexpected character {ch!r}")
    tokens.append(Token("EOF", "", n, n))
    return tokens
