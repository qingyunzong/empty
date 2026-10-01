"""Query language: lexer, parser and AST.

Grammar (precedence low -> high)::

    or      := and (OR and)*
    and     := unary (AND unary)*
    unary   := NOT unary | near
    near    := postfix (NEAR/<n> postfix)*
    postfix := [field ':'] atom
    atom    := '(' or ')' | '"' phrase '"' | term

``NOT`` is a unary boolean operator with complement semantics over the full
document universe of the queried index or snapshot.
"""
from __future__ import annotations

import re
from dataclasses import dataclass

from .model import tokenize


class QueryError(Exception):
    """Raised for lexical, syntactic or static type errors in a query."""


# ---------------------------------------------------------------- AST nodes

@dataclass(frozen=True)
class Term:
    text: str


@dataclass(frozen=True)
class Phrase:
    terms: tuple[str, ...]


@dataclass(frozen=True)
class Field:
    spec: str
    child: object


@dataclass(frozen=True)
class And:
    left: object
    right: object


@dataclass(frozen=True)
class Or:
    left: object
    right: object


@dataclass(frozen=True)
class Not:
    child: object


@dataclass(frozen=True)
class Near:
    left: object
    right: object
    distance: int


# ---------------------------------------------------------------- lexer

_TOKEN_RE = re.compile(
    r"""
    \s*(?:
        (?P<lpar>\() |
        (?P<rpar>\)) |
        (?P<colon>:) |
        (?P<phrase>"(?:[^"\\]|\\.)*") |
        (?P<near>NEAR/[0-9]+) |
        (?P<word>[^\s():/"]+)
    )
    """,
    re.VERBOSE | re.IGNORECASE,
)


@dataclass(frozen=True)
class _Tok:
    kind: str
    value: str


def _lex(text: str) -> list[_Tok]:
    tokens: list[_Tok] = []
    pos = 0
    while pos < len(text):
        if text[pos:].strip() == "":
            break
        m = _TOKEN_RE.match(text, pos)
        if not m or m.start() == m.end() and m.end() < len(text) and text[pos] not in " \t":
            raise QueryError(f"cannot tokenize query at offset {pos}: {text[pos:]!r}")
        if m is None:
            raise QueryError(f"cannot tokenize query at offset {pos}")
        pos = m.end()
        kind = m.lastgroup
        value = m.group()
        tokens.append(_Tok(kind, value.strip()))
    return tokens


# ---------------------------------------------------------------- parser

class _Parser:
    def __init__(self, tokens: list[_Tok]):
        self.tokens = tokens
        self.i = 0

    def peek(self) -> _Tok | None:
        return self.tokens[self.i] if self.i < len(self.tokens) else None

    def next(self) -> _Tok:
        tok = self.peek()
        if tok is None:
            raise QueryError("unexpected end of query")
        self.i += 1
        return tok

    def expect_word(self, word: str) -> None:
        tok = self.next()
        if tok.kind != "word" or tok.value.upper() != word:
            raise QueryError(f"expected {word}, got {tok.value!r}")

    # or := and (OR and)*
    def parse_or(self):
        node = self.parse_and()
        while self.peek() and self.peek().kind == "word" and self.peek().value.upper() == "OR":
            self.next()
            node = Or(node, self.parse_and())
        return node

    # and := unary (AND unary)*
    def parse_and(self):
        node = self.parse_unary()
        while self.peek() and self.peek().kind == "word" and self.peek().value.upper() == "AND":
            self.next()
            node = And(node, self.parse_unary())
        return node

    # unary := NOT unary | near
    def parse_unary(self):
        tok = self.peek()
        if tok and tok.kind == "word" and tok.value.upper() == "NOT":
            self.next()
            return Not(self.parse_unary())
        return self.parse_near()

    # near := postfix (NEAR/n postfix)*
    def parse_near(self):
        node = self.parse_postfix()
        while self.peek() and self.peek().kind == "near":
            tok = self.next()
            distance = int(tok.value.split("/", 1)[1])
            node = Near(node, self.parse_postfix(), distance)
        return node

    # postfix := [word ':'] atom
    def parse_postfix(self):
        tok = self.peek()
        if (
            tok is not None
            and tok.kind == "word"
            and tok.value.upper() not in ("AND", "OR", "NOT")
            and self.i + 1 < len(self.tokens)
            and self.tokens[self.i + 1].kind == "colon"
        ):
            spec = self.next().value
            self.next()  # colon
            return Field(spec, self.parse_postfix())
        return self.parse_atom()

    def parse_atom(self):
        tok = self.next()
        if tok.kind == "lpar":
            node = self.parse_or()
            closing = self.next()
            if closing.kind != "rpar":
                raise QueryError("missing closing parenthesis")
            return node
        if tok.kind == "phrase":
            inner = tok.value.strip()
            if len(inner) >= 2 and inner[0] == '"' and inner[-1] == '"':
                inner = inner[1:-1]
            inner = inner.replace('\\"', '"').replace("\\\\", "\\")
            terms = tuple(t.text for t in tokenize(inner))
            if not terms:
                raise QueryError("empty phrase")
            if len(terms) == 1:
                return Term(terms[0])
            return Phrase(terms)
        if tok.kind == "word":
            word = tok.value
            if word.upper() in ("AND", "OR", "NOT"):
                raise QueryError(f"unexpected operator {word!r}")
            terms = tuple(t.text for t in tokenize(word))
            if not terms:
                raise QueryError(f"invalid term {word!r}")
            if len(terms) == 1:
                return Term(terms[0])
            return Phrase(terms)
        raise QueryError(f"unexpected token {tok.value!r}")


def parse(text: str):
    """Parse a query string into an AST."""
    tokens = _lex(text)
    if not tokens:
        raise QueryError("empty query")
    parser = _Parser(tokens)
    node = parser.parse_or()
    if parser.peek() is not None:
        raise QueryError(f"trailing tokens after query: {parser.peek().value!r}")
    return node
