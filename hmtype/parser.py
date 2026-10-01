"""Recursive-descent parser producing a list of top-level let declarations."""
from __future__ import annotations

from typing import List, Tuple

from . import ast
from .lexer import LexError, Token, tokenize

CMP_OPS = {"<", ">", "<=", ">=", "=", "<>"}
ADD_OPS = {"+", "-"}
MUL_OPS = {"*"}


class ParseError(Exception):
    def __init__(self, message: str, span: ast.Span) -> None:
        super().__init__(message)
        self.message = message
        self.span = span

    def to_json(self) -> dict:
        return {"kind": "ParseError", "message": self.message, "span": self.span.to_json()}


def _span_of(tok: Token) -> ast.Span:
    return ast.Span(tok.line, tok.col, tok.end_line, tok.end_col)


class Parser:
    def __init__(self, tokens: List[Token]) -> None:
        self.tokens = tokens
        self.pos = 0

    def peek(self) -> Token:
        return self.tokens[self.pos]

    def prev(self) -> Token:
        return self.tokens[self.pos - 1]

    def advance(self) -> Token:
        tok = self.tokens[self.pos]
        self.pos += 1
        return tok

    def at_sym(self, sym: str) -> bool:
        tok = self.peek()
        return tok.kind == "SYM" and tok.value == sym

    def at_kw(self, kw: str) -> bool:
        tok = self.peek()
        return tok.kind == "KW" and tok.value == kw

    def expect_sym(self, sym: str) -> Token:
        if not self.at_sym(sym):
            self.fail(f"expected {sym!r}")
        return self.advance()

    def expect_kw(self, kw: str) -> Token:
        if not self.at_kw(kw):
            self.fail(f"expected {kw!r}")
        return self.advance()

    def expect_ident(self) -> Token:
        if self.peek().kind != "IDENT":
            self.fail("expected an identifier")
        return self.advance()

    def fail(self, message: str) -> None:
        tok = self.peek()
        got = repr(tok.value) if tok.value else "end of input"
        raise ParseError(f"{message}, got {got}", _span_of(tok))

    def span_from(self, start: Token) -> ast.Span:
        end = self.prev()
        return ast.Span(start.line, start.col, end.end_line, end.end_col)

    # -- program ---------------------------------------------------------
    def parse_program(self) -> List[Tuple[str, ast.Node]]:
        decls: List[Tuple[str, ast.Node]] = []
        self.skip_newlines()
        while self.peek().kind != "EOF":
            decls.append(self.parse_decl())
            if self.peek().kind not in ("NEWLINE", "EOF"):
                self.fail("expected a newline after top-level declaration")
            self.skip_newlines()
        return decls

    def skip_newlines(self) -> None:
        while self.peek().kind == "NEWLINE":
            self.advance()

    def parse_decl(self) -> Tuple[str, ast.Node]:
        self.expect_kw("let")
        name = self.expect_ident()
        self.expect_sym("=")
        expr = self.parse_expr()
        return name.value, expr

    # -- expressions -----------------------------------------------------
    def parse_expr(self) -> ast.Node:
        tok = self.peek()
        if tok.kind == "KW":
            if tok.value == "fun":
                return self.parse_lambda()
            if tok.value == "let":
                return self.parse_let()
            if tok.value == "if":
                return self.parse_if()
            if tok.value == "fix":
                return self.parse_fix()
        return self.parse_tuple()

    def parse_lambda(self) -> ast.Node:
        start = self.expect_kw("fun")
        param = self.expect_ident()
        self.expect_sym("->")
        body = self.parse_expr()
        return ast.Lam(param.value, body, self.span_from(start))

    def parse_let(self) -> ast.Node:
        start = self.expect_kw("let")
        name = self.expect_ident()
        self.expect_sym("=")
        value = self.parse_expr()
        self.expect_kw("in")
        body = self.parse_expr()
        return ast.Let(name.value, value, body, self.span_from(start))

    def parse_if(self) -> ast.Node:
        start = self.expect_kw("if")
        cond = self.parse_expr()
        self.expect_kw("then")
        then = self.parse_expr()
        self.expect_kw("else")
        els = self.parse_expr()
        return ast.If(cond, then, els, self.span_from(start))

    def parse_fix(self) -> ast.Node:
        start = self.expect_kw("fix")
        param = self.expect_ident()
        self.expect_sym("->")
        body = self.parse_expr()
        return ast.Fix(param.value, body, self.span_from(start))

    def parse_tuple(self) -> ast.Node:
        start = self.peek()
        first = self.parse_cmp()
        if not self.at_sym(","):
            return first
        elems = [first]
        while self.at_sym(","):
            self.advance()
            elems.append(self.parse_cmp())
        return ast.TupleLit(tuple(elems), self.span_from(start))

    def parse_cmp(self) -> ast.Node:
        left = self.parse_add()
        tok = self.peek()
        if tok.kind == "SYM" and tok.value in CMP_OPS:
            self.advance()
            right = self.parse_add()
            return ast.BinOp(tok.value, left, right, self.span_from(self._start_of(left)))
        return left

    def parse_add(self) -> ast.Node:
        left = self.parse_mul()
        while True:
            tok = self.peek()
            if tok.kind == "SYM" and tok.value in ADD_OPS:
                self.advance()
                right = self.parse_mul()
                left = ast.BinOp(tok.value, left, right, self.span_from(self._start_of(left)))
            else:
                return left

    def parse_mul(self) -> ast.Node:
        left = self.parse_app()
        while True:
            tok = self.peek()
            if tok.kind == "SYM" and tok.value in MUL_OPS:
                self.advance()
                right = self.parse_app()
                left = ast.BinOp(tok.value, left, right, self.span_from(self._start_of(left)))
            else:
                return left

    def parse_app(self) -> ast.Node:
        func = self.parse_atom()
        while self.starts_atom():
            arg = self.parse_atom()
            func = ast.App(func, arg, self.span_from(self._start_of(func)))
        return func

    def starts_atom(self) -> bool:
        tok = self.peek()
        if tok.kind in ("INT", "IDENT"):
            return True
        if tok.kind == "SYM" and tok.value == "(":
            return True
        if tok.kind == "KW" and tok.value in ("true", "false"):
            return True
        return False

    def parse_atom(self) -> ast.Node:
        tok = self.peek()
        if tok.kind == "INT":
            self.advance()
            return ast.IntLit(int(tok.value), _span_of(tok))
        if tok.kind == "IDENT":
            self.advance()
            return ast.Var(tok.value, _span_of(tok))
        if tok.kind == "KW" and tok.value in ("true", "false"):
            self.advance()
            return ast.BoolLit(tok.value == "true", _span_of(tok))
        if tok.kind == "SYM" and tok.value == "(":
            self.advance()
            expr = self.parse_expr()
            self.expect_sym(")")
            return expr
        self.fail("expected an expression")
        raise AssertionError  # unreachable

    def _start_of(self, node: ast.Node) -> Token:
        span = node.span
        return Token("", "", span.line, span.col, span.line, span.col)


def parse_program(src: str) -> List[Tuple[str, ast.Node]]:
    try:
        tokens = tokenize(src)
    except LexError as exc:
        span = ast.Span(exc.line, exc.col, exc.line, exc.col + 1)
        raise ParseError(exc.message, span) from exc
    return Parser(tokens).parse_program()
