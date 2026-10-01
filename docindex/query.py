"""Query language: lexer, parser and AST.

Grammar (juxtaposition means AND, ``NOT`` binds tighter than ``AND`` which
binds tighter than ``OR``; ``NEAR`` binds tighter than ``NOT``)::

    query    := or_expr
    or_expr  := and_expr (OR and_expr)*
    and_expr := unary ((AND)? unary)*
    unary    := NOT unary | near_expr
    near_expr:= primary (NEAR[/k] primary)*
    primary  := '(' or_expr ')' | field? operand
    field    := WORD ':'
    operand  := PHRASE | WORD

``*`` alone matches all documents; ``field:*`` tests that the field exists
and has at least one token.  Operators are case-insensitive when unquoted.
"""
from __future__ import annotations

import re
from dataclasses import dataclass, field as _dc_field

from .errors import QueryError
from .tokenizer import tokenize

DEFAULT_NEAR_DISTANCE = 10

_NEAR_RE = re.compile(r"NEAR(?:/(\d+))?", re.IGNORECASE)


# ---------------------------------------------------------------------------
# AST nodes
# ---------------------------------------------------------------------------

@dataclass(frozen=True)
class Term:
    field: str | None
    term: str


@dataclass(frozen=True)
class Phrase:
    field: str | None
    terms: tuple


@dataclass(frozen=True)
class FieldExists:
    field: str


@dataclass(frozen=True)
class AllDocs:
    pass


@dataclass(frozen=True)
class Near:
    left: object
    right: object
    k: int


@dataclass(frozen=True)
class And:
    children: tuple


@dataclass(frozen=True)
class Or:
    children: tuple


@dataclass(frozen=True)
class Not:
    child: object


# ---------------------------------------------------------------------------
# Lexer
# ---------------------------------------------------------------------------

def _lex(text: str) -> list[tuple[str, object]]:
    tokens: list[tuple[str, object]] = []
    i = 0
    n = len(text)
    while i < n:
        ch = text[i]
        if ch.isspace():
            i += 1
        elif ch == "(":
            tokens.append(("LP", "("))
            i += 1
        elif ch == ")":
            tokens.append(("RP", ")"))
            i += 1
        elif ch == ":":
            tokens.append(("COLON", ":"))
            i += 1
        elif ch == '"':
            end = text.find('"', i + 1)
            if end < 0:
                raise QueryError("unterminated phrase in query")
            tokens.append(("PHRASE", text[i + 1 : end]))
            i = end + 1
        else:
            j = i
            while j < n and not text[j].isspace() and text[j] not in '():"':
                j += 1
            word = text[i:j]
            upper = word.upper()
            if upper in ("AND", "OR", "NOT"):
                tokens.append((upper, None))
            else:
                near = _NEAR_RE.fullmatch(word)
                if near:
                    tokens.append(("NEAR", int(near.group(1)) if near.group(1) else None))
                else:
                    tokens.append(("WORD", word))
            i = j
    tokens.append(("EOF", None))
    return tokens


# ---------------------------------------------------------------------------
# Parser
# ---------------------------------------------------------------------------

class _Parser:
    def __init__(self, tokens):
        self.tokens = tokens
        self.i = 0

    def peek(self):
        return self.tokens[self.i]

    def next(self):
        tok = self.tokens[self.i]
        self.i += 1
        return tok

    def expect(self, kind):
        tok = self.next()
        if tok[0] != kind:
            raise QueryError(f"expected {kind}, got {tok[0]} ({tok[1]!r})")
        return tok

    # grammar ------------------------------------------------------------
    def parse(self):
        node = self.or_expr()
        tok = self.peek()
        if tok[0] != "EOF":
            raise QueryError(f"unexpected trailing token: {tok[1]!r}")
        return node

    def or_expr(self):
        nodes = [self.and_expr()]
        while self.peek()[0] == "OR":
            self.next()
            nodes.append(self.and_expr())
        return nodes[0] if len(nodes) == 1 else Or(tuple(nodes))

    def and_expr(self):
        nodes = [self.unary()]
        while True:
            kind = self.peek()[0]
            if kind == "AND":
                self.next()
                nodes.append(self.unary())
            elif kind in ("WORD", "PHRASE", "LP", "NOT"):
                nodes.append(self.unary())
            else:
                break
        return nodes[0] if len(nodes) == 1 else And(tuple(nodes))

    def unary(self):
        if self.peek()[0] == "NOT":
            self.next()
            return Not(self.unary())
        return self.near_expr()

    def near_expr(self):
        left = self.primary()
        while self.peek()[0] == "NEAR":
            _, k = self.next()
            right = self.primary()
            left = Near(left, right, k if k is not None else DEFAULT_NEAR_DISTANCE)
        return left

    def primary(self):
        kind, value = self.next()
        if kind == "LP":
            node = self.or_expr()
            self.expect("RP")
            return node
        if kind == "WORD":
            if self.peek()[0] == "COLON":
                self.next()
                return self._field_operand(value)
            return _word_operand(None, value)
        if kind == "PHRASE":
            return _make_phrase(None, value)
        raise QueryError(f"unexpected token: {value!r}")

    def _field_operand(self, field_name):
        kind, value = self.next()
        if kind == "WORD":
            return _word_operand(field_name, value)
        if kind == "PHRASE":
            return _make_phrase(field_name, value)
        raise QueryError(f"expected term or phrase after '{field_name}:'")


def _word_operand(field_name, word):
    if word == "*":
        return AllDocs() if field_name is None else FieldExists(field_name)
    return Term(field_name, word.lower())


def _make_phrase(field_name, text):
    terms = tuple(tok.term for tok in tokenize(text))
    if not terms:
        raise QueryError("empty phrase")
    if len(terms) == 1:
        return Term(field_name, terms[0])
    return Phrase(field_name, terms)


def parse_query(text: str):
    """Parse a query string into an AST.  Raises :class:`QueryError`."""
    if not isinstance(text, str) or not text.strip():
        raise QueryError("empty query")
    return _Parser(_lex(text)).parse()
