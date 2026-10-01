"""Lexer and parser for the mini language.

Grammar (loosest to tightest binding):

    expr        := "let" IDENT "=" expr "in" expr
                 | "fun" IDENT "->" expr
                 | "if" expr "then" expr "else" expr
                 | "fix" expr
                 | comparison
    comparison  := arith (("<"|"<="|">"|">="|"=="|"!=") arith)?
    arith       := term (("+"|"-") term)*
    term        := app (("*"|"/") app)*
    app         := atom+
    atom        := INT | "true" | "false" | IDENT
                 | "-" atom
                 | "(" expr ")" | "(" expr ("," expr)+ ")"

A program is a sequence of top-level lets (no "in"), optionally separated
by ";;". "#" starts a line comment.
"""

from __future__ import annotations

from dataclasses import dataclass

from .errors import ParseError, Span

KEYWORDS = {"let", "in", "fun", "if", "then", "else", "fix", "true", "false"}
TWO_CHAR = {"->", "<=", ">=", "==", "!=", ";;"}
ONE_CHAR = set("=(),+-*/<>")


@dataclass
class Token:
    kind: str
    text: str
    line: int
    col: int
    end_line: int
    end_col: int

    @property
    def span(self) -> Span:
        return (self.line, self.col, self.end_line, self.end_col)


def lex(src: str) -> list[Token]:
    tokens: list[Token] = []
    i = 0
    line, col = 1, 1
    n = len(src)
    while i < n:
        c = src[i]
        if c in " \t\r":
            i += 1
            col += 1
            continue
        if c == "\n":
            i += 1
            line += 1
            col = 1
            continue
        if c == "#":
            while i < n and src[i] != "\n":
                i += 1
                col += 1
            continue
        start_line, start_col = line, col
        if c.isdigit():
            j = i
            while j < n and src[j].isdigit():
                j += 1
            text = src[i:j]
            col += j - i
            i = j
            tokens.append(Token("INT", text, start_line, start_col, line, col))
            continue
        if c.isalpha() or c == "_":
            j = i
            while j < n and (src[j].isalnum() or src[j] in "_'"):
                j += 1
            text = src[i:j]
            col += j - i
            i = j
            kind = text if text in KEYWORDS else "IDENT"
            tokens.append(Token(kind, text, start_line, start_col, line, col))
            continue
        two = src[i:i + 2]
        if two in TWO_CHAR:
            i += 2
            col += 2
            tokens.append(Token(two, two, start_line, start_col, line, col))
            continue
        if c in ONE_CHAR:
            i += 1
            col += 1
            tokens.append(Token(c, c, start_line, start_col, line, col))
            continue
        raise ParseError(f"unexpected character {c!r}",
                         (start_line, start_col, start_line, start_col + 1))
    tokens.append(Token("EOF", "", line, col, line, col))
    return tokens


# ---------------------------------------------------------------- AST

@dataclass
class Node:
    span: Span


@dataclass
class IntLit(Node):
    value: int


@dataclass
class BoolLit(Node):
    value: bool


@dataclass
class Var(Node):
    name: str


@dataclass
class Lam(Node):
    param: str
    body: Node


@dataclass
class App(Node):
    fn: Node
    arg: Node


@dataclass
class Let(Node):
    name: str
    rhs: Node
    body: Node


@dataclass
class If(Node):
    cond: Node
    then: Node
    els: Node


@dataclass
class Fix(Node):
    expr: Node


@dataclass
class BinOp(Node):
    op: str
    left: Node
    right: Node


@dataclass
class Tuple(Node):
    elems: list[Node]


@dataclass
class TopLet(Node):
    name: str
    rhs: Node


ARITH_OPS = {"+", "-", "*", "/"}
COMPARE_OPS = {"<", "<=", ">", ">="}
EQ_OPS = {"==", "!="}


# ---------------------------------------------------------------- parser

class Parser:
    def __init__(self, tokens: list[Token]):
        self.toks = tokens
        self.pos = 0

    def peek(self) -> Token:
        return self.toks[self.pos]

    def advance(self) -> Token:
        t = self.toks[self.pos]
        if t.kind != "EOF":
            self.pos += 1
        return t

    def expect(self, kind: str) -> Token:
        t = self.peek()
        if t.kind != kind:
            raise ParseError(f"expected {kind!r}, found {t.text!r}", t.span)
        return self.advance()

    @staticmethod
    def _span(a: Span, b: Span) -> Span:
        return (a[0], a[1], b[2], b[3])

    def parse_expr(self) -> Node:
        t = self.peek()
        if t.kind == "let":
            self.advance()
            name = self.expect("IDENT").text
            self.expect("=")
            rhs = self.parse_expr()
            self.expect("in")
            body = self.parse_expr()
            return Let(self._span(t.span, body.span), name, rhs, body)
        if t.kind == "fun":
            self.advance()
            param = self.expect("IDENT").text
            self.expect("->")
            body = self.parse_expr()
            return Lam(self._span(t.span, body.span), param, body)
        if t.kind == "if":
            self.advance()
            cond = self.parse_expr()
            self.expect("then")
            then = self.parse_expr()
            self.expect("else")
            els = self.parse_expr()
            return If(self._span(t.span, els.span), cond, then, els)
        if t.kind == "fix":
            self.advance()
            e = self.parse_expr()
            return Fix(self._span(t.span, e.span), e)
        return self.parse_comparison()

    def parse_comparison(self) -> Node:
        left = self.parse_arith()
        t = self.peek()
        if t.kind in COMPARE_OPS | EQ_OPS:
            self.advance()
            right = self.parse_arith()
            return BinOp(self._span(left.span, right.span), t.kind, left, right)
        return left

    def parse_arith(self) -> Node:
        left = self.parse_term()
        while self.peek().kind in ("+", "-"):
            op = self.advance()
            right = self.parse_term()
            left = BinOp(self._span(left.span, right.span), op.kind, left, right)
        return left

    def parse_term(self) -> Node:
        left = self.parse_app()
        while self.peek().kind in ("*", "/"):
            op = self.advance()
            right = self.parse_app()
            left = BinOp(self._span(left.span, right.span), op.kind, left, right)
        return left

    ATOM_STARTS = {"INT", "IDENT", "true", "false", "("}

    def parse_app(self) -> Node:
        fn = self.parse_atom()
        while self.peek().kind in self.ATOM_STARTS:
            arg = self.parse_atom()
            fn = App(self._span(fn.span, arg.span), fn, arg)
        return fn

    def parse_atom(self) -> Node:
        t = self.peek()
        if t.kind == "INT":
            self.advance()
            return IntLit(t.span, int(t.text))
        if t.kind == "true":
            self.advance()
            return BoolLit(t.span, True)
        if t.kind == "false":
            self.advance()
            return BoolLit(t.span, False)
        if t.kind == "IDENT":
            self.advance()
            return Var(t.span, t.text)
        if t.kind == "-":
            self.advance()
            e = self.parse_atom()
            zero = IntLit(t.span, 0)
            return BinOp(self._span(t.span, e.span), "-", zero, e)
        if t.kind == "(":
            self.advance()
            e = self.parse_expr()
            if self.peek().kind == ",":
                elems = [e]
                while self.peek().kind == ",":
                    self.advance()
                    elems.append(self.parse_expr())
                close = self.expect(")")
                return Tuple(self._span(t.span, close.span), elems)
            close = self.expect(")")
            e.span = self._span(t.span, close.span)
            return e
        raise ParseError(f"unexpected token {t.text!r}", t.span)


def parse_expr(src: str) -> Node:
    """Parse a single expression (used by tests and infer_expr)."""
    p = Parser(lex(src))
    node = p.parse_expr()
    t = p.peek()
    if t.kind != "EOF":
        raise ParseError(f"unexpected trailing token {t.text!r}", t.span)
    return node


def parse_program(src: str) -> list[TopLet]:
    p = Parser(lex(src))
    items: list[TopLet] = []
    while p.peek().kind != "EOF":
        t = p.expect("let")
        name = p.expect("IDENT").text
        p.expect("=")
        rhs = p.parse_expr()
        items.append(TopLet(Parser._span(t.span, rhs.span), name, rhs))
        if p.peek().kind == ";;":
            p.advance()
    return items
