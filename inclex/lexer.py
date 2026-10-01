"""Simplified-pattern lexer with explicit lexer states.

Token kinds: IDENT, NUMBER, STRING, LINE_COMMENT, BLOCK_COMMENT, OP.
Whitespace is skipped.  Block comments may span lines but do not nest.

Every token records the lexer state at its start.  A position is a *safe*
rescan point when that state is STATE_MAIN, i.e. the lexer is in its main
mode and not inside a string or a comment.
"""
from __future__ import annotations

from dataclasses import dataclass

STATE_MAIN = "main"
STATE_IN_STRING = "in_string"
STATE_IN_LINE_COMMENT = "in_line_comment"
STATE_IN_BLOCK_COMMENT = "in_block_comment"

IDENT = "IDENT"
NUMBER = "NUMBER"
STRING = "STRING"
LINE_COMMENT = "LINE_COMMENT"
BLOCK_COMMENT = "BLOCK_COMMENT"
OP = "OP"

_IDENT_START = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ_"
_IDENT_CONT = _IDENT_START + "0123456789"
_DIGITS = "0123456789"

MULTI_OPS = (
    "==", "!=", "<=", ">=", "&&", "||",
    "+=", "-=", "*=", "/=", "++", "--",
    "->", "<<", ">>",
)
SINGLE_OPS = frozenset("+-*/%=<>!&|^~()[]{};,.:?")


class LexError(Exception):
    """Lexical error carrying the byte/char offset and the lexer state."""

    def __init__(self, message: str, offset: int, state: str):
        super().__init__(message)
        self.message = message
        self.offset = offset
        self.state = state

    def __str__(self) -> str:
        return f"{self.message} (offset={self.offset}, state={self.state})"


@dataclass(frozen=True)
class Token:
    type: str
    text: str
    start: int
    end: int
    state: str = STATE_MAIN  # lexer state at the token start

    def shift(self, delta: int) -> "Token":
        return Token(self.type, self.text, self.start + delta,
                     self.end + delta, self.state)

    def to_dict(self) -> dict:
        return {
            "type": self.type,
            "text": self.text,
            "start": self.start,
            "end": self.end,
            "state": self.state,
        }


def scan_token(text: str, pos: int):
    """Scan one token at or after *pos*, skipping whitespace.

    Returns ``(token, next_pos)``, or ``(None, next_pos)`` when only
    whitespace remains.  Raises :class:`LexError` on unterminated
    constructs or unexpected characters.
    """
    n = len(text)
    i = pos
    while i < n and text[i].isspace():
        i += 1
    if i >= n:
        return None, i
    start = i
    c = text[i]

    if c in _IDENT_START:
        i += 1
        while i < n and text[i] in _IDENT_CONT:
            i += 1
        return Token(IDENT, text[start:i], start, i), i

    if c in _DIGITS:
        i += 1
        while i < n and text[i] in _DIGITS:
            i += 1
        if i + 1 < n and text[i] == "." and text[i + 1] in _DIGITS:
            i += 2
            while i < n and text[i] in _DIGITS:
                i += 1
        return Token(NUMBER, text[start:i], start, i), i

    if c == '"' or c == "'":
        quote = c
        i += 1
        while i < n:
            ch = text[i]
            if ch == "\\" and i + 1 < n and text[i + 1] != "\n":
                i += 2
                continue
            if ch == quote:
                return Token(STRING, text[start:i + 1], start, i + 1), i + 1
            if ch == "\n":
                break
            i += 1
        raise LexError("unterminated string literal", start, STATE_IN_STRING)

    if c == "/" and i + 1 < n and text[i + 1] == "/":
        i += 2
        while i < n and text[i] != "\n":
            i += 1
        return Token(LINE_COMMENT, text[start:i], start, i), i

    if c == "/" and i + 1 < n and text[i + 1] == "*":
        close = text.find("*/", i + 2)
        if close == -1:
            raise LexError("unterminated block comment", start,
                           STATE_IN_BLOCK_COMMENT)
        i = close + 2
        return Token(BLOCK_COMMENT, text[start:i], start, i), i

    for op in MULTI_OPS:
        if text.startswith(op, i):
            i += len(op)
            return Token(OP, text[start:i], start, i), i

    if c in SINGLE_OPS:
        return Token(OP, c, start, start + 1), start + 1

    raise LexError(f"unexpected character {c!r}", start, STATE_MAIN)


def lex_full(text: str) -> list[Token]:
    """Lex the whole text from offset 0."""
    tokens: list[Token] = []
    pos = 0
    while True:
        tok, pos = scan_token(text, pos)
        if tok is None:
            return tokens
        tokens.append(tok)
