"""Tokenizer for the mini language.

NEWLINE tokens are emitted only at parenthesis depth 0, so a top-level
"let" declaration is terminated by a newline while parenthesised
expressions may span multiple lines. "--" starts a line comment.
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import List

KEYWORDS = {"let", "in", "if", "then", "else", "fun", "fix", "true", "false"}
SYMBOLS = ["->", "<=", ">=", "<>", "(", ")", ",", "=", "+", "-", "*", "<", ">"]


class LexError(Exception):
    def __init__(self, message: str, line: int, col: int) -> None:
        super().__init__(message)
        self.message = message
        self.line = line
        self.col = col


@dataclass(frozen=True)
class Token:
    kind: str  # INT | IDENT | KW | SYM | NEWLINE | EOF
    value: str
    line: int
    col: int
    end_line: int
    end_col: int


def tokenize(src: str) -> List[Token]:
    tokens: List[Token] = []
    i = 0
    line, col = 1, 1
    depth = 0
    n = len(src)

    def advance(text: str) -> None:
        nonlocal line, col
        for ch in text:
            if ch == "\n":
                line += 1
                col = 1
            else:
                col += 1

    while i < n:
        ch = src[i]
        start_line, start_col = line, col
        if ch in " \t\r":
            advance(ch)
            i += 1
            continue
        if ch == "\n":
            advance(ch)
            i += 1
            if depth == 0 and (not tokens or tokens[-1].kind != "NEWLINE"):
                tokens.append(Token("NEWLINE", "\n", start_line, start_col, line, col))
            continue
        if src.startswith("--", i):
            j = src.find("\n", i)
            if j == -1:
                j = n
            advance(src[i:j])
            i = j
            continue
        if ch.isdigit():
            j = i
            while j < n and src[j].isdigit():
                j += 1
            text = src[i:j]
            advance(text)
            tokens.append(Token("INT", text, start_line, start_col, line, col))
            i = j
            continue
        if ch.isalpha() or ch == "_":
            j = i
            while j < n and (src[j].isalnum() or src[j] in "_'"):
                j += 1
            text = src[i:j]
            advance(text)
            kind = "KW" if text in KEYWORDS else "IDENT"
            tokens.append(Token(kind, text, start_line, start_col, line, col))
            i = j
            continue
        matched = None
        for sym in SYMBOLS:
            if src.startswith(sym, i):
                matched = sym
                break
        if matched is None:
            raise LexError(f"unexpected character {ch!r}", line, col)
        advance(matched)
        if matched == "(":
            depth += 1
        elif matched == ")":
            depth -= 1
            if depth < 0:
                raise LexError("unbalanced ')'", start_line, start_col)
        tokens.append(Token("SYM", matched, start_line, start_col, line, col))
        i += len(matched)
    if depth != 0:
        raise LexError("unbalanced '('", line, col)
    tokens.append(Token("EOF", "", line, col, line, col))
    return tokens
