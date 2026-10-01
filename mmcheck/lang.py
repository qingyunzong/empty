"""Lexer and parser for the mini module language.

Grammar (one statement per line):

    module  := (import_decl | let_decl | fun_decl | NEWLINE)*
    import  := "import" NAME
    let     := "let" NAME (":" type)? "=" expr
    fun     := "fun" NAME "(" params? ")" "->" type "=" expr
    params  := NAME ":" type ("," NAME ":" type)*
    type    := "Int"
    expr    := term ("+" term)*
    term    := factor ("*" factor)*
    factor  := INT | NAME ("(" args? ")")? | "(" expr ")"
"""
from __future__ import annotations

from dataclasses import dataclass, field


class ParseError(Exception):
    """Raised on any lexical or syntactic error (reported as E_PARSE)."""

    def __init__(self, message: str, line: int):
        super().__init__(f"line {line}: {message}")
        self.message = message
        self.line = line


# ---------------------------------------------------------------------------
# Types (shared between parser annotations and the checker)
# ---------------------------------------------------------------------------

@dataclass(frozen=True)
class TInt:
    def __str__(self) -> str:
        return "Int"


@dataclass(frozen=True)
class TFun:
    params: tuple
    ret: object

    def __str__(self) -> str:
        return f"({', '.join(str(p) for p in self.params)}) -> {self.ret}"


INT = TInt()


# ---------------------------------------------------------------------------
# Lexer
# ---------------------------------------------------------------------------

@dataclass
class Token:
    kind: str
    text: str
    line: int


_PUNCT = {":", "=", "(", ")", ",", "+", "*"}


def tokenize(src: str) -> list[Token]:
    tokens: list[Token] = []
    line = 1
    i = 0
    n = len(src)
    while i < n:
        c = src[i]
        if c == "\n":
            tokens.append(Token("NEWLINE", "\n", line))
            line += 1
            i += 1
        elif c in " \t\r":
            i += 1
        elif c == "#":
            while i < n and src[i] != "\n":
                i += 1
        elif c.isdigit():
            j = i
            while j < n and src[j].isdigit():
                j += 1
            tokens.append(Token("INT", src[i:j], line))
            i = j
        elif c.isalpha() or c == "_":
            j = i
            while j < n and (src[j].isalnum() or src[j] == "_"):
                j += 1
            tokens.append(Token("NAME", src[i:j], line))
            i = j
        elif c == "-" and i + 1 < n and src[i + 1] == ">":
            tokens.append(Token("ARROW", "->", line))
            i += 2
        elif c in _PUNCT:
            tokens.append(Token(c, c, line))
            i += 1
        else:
            raise ParseError(f"unexpected character {c!r}", line)
    tokens.append(Token("EOF", "", line))
    return tokens


# ---------------------------------------------------------------------------
# AST
# ---------------------------------------------------------------------------

@dataclass
class Num:
    value: int
    line: int


@dataclass
class Var:
    name: str
    line: int


@dataclass
class Bin:
    op: str
    left: object
    right: object
    line: int


@dataclass
class Call:
    func: object
    args: list
    line: int


@dataclass
class Let:
    name: str
    ann: object  # TInt or None
    expr: object
    line: int


@dataclass
class Fun:
    name: str
    params: list  # list of (name, TInt)
    ret: object
    body: object
    line: int


@dataclass
class Module:
    imports: list  # list of (module_name, line)
    decls: list


# ---------------------------------------------------------------------------
# Parser
# ---------------------------------------------------------------------------

class Parser:
    def __init__(self, tokens: list[Token]):
        self.tokens = tokens
        self.pos = 0

    def peek(self) -> Token:
        return self.tokens[self.pos]

    def advance(self) -> Token:
        tok = self.tokens[self.pos]
        self.pos += 1
        return tok

    def expect(self, kind: str, what: str | None = None) -> Token:
        tok = self.peek()
        if tok.kind != kind:
            got = repr(tok.text) if tok.text else "end of input"
            raise ParseError(f"expected {what or kind}, got {got}", tok.line)
        return self.advance()

    def _skip_newlines(self) -> None:
        while self.peek().kind == "NEWLINE":
            self.advance()

    def parse_module(self) -> Module:
        imports: list = []
        decls: list = []
        self._skip_newlines()
        while self.peek().kind != "EOF":
            tok = self.peek()
            if tok.kind == "NAME" and tok.text == "import":
                self.advance()
                name = self.expect("NAME", "module name")
                imports.append((name.text, tok.line))
            elif tok.kind == "NAME" and tok.text == "let":
                decls.append(self.parse_let())
            elif tok.kind == "NAME" and tok.text == "fun":
                decls.append(self.parse_fun())
            else:
                raise ParseError(f"unexpected {tok.text!r}", tok.line)
            if self.peek().kind not in ("NEWLINE", "EOF"):
                raise ParseError(
                    f"expected end of line, got {self.peek().text!r}",
                    self.peek().line,
                )
            self._skip_newlines()
        return Module(imports, decls)

    def parse_let(self) -> Let:
        start = self.advance()  # 'let'
        name = self.expect("NAME", "variable name")
        ann = None
        if self.peek().kind == ":":
            self.advance()
            ann = self.parse_type()
        self.expect("=", "'='")
        expr = self.parse_expr()
        return Let(name.text, ann, expr, start.line)

    def parse_fun(self) -> Fun:
        start = self.advance()  # 'fun'
        name = self.expect("NAME", "function name")
        self.expect("(", "'('")
        params = []
        if self.peek().kind != ")":
            params.append(self.parse_param())
            while self.peek().kind == ",":
                self.advance()
                params.append(self.parse_param())
        self.expect(")", "')'")
        self.expect("ARROW", "'->'")
        ret = self.parse_type()
        self.expect("=", "'='")
        body = self.parse_expr()
        return Fun(name.text, params, ret, body, start.line)

    def parse_param(self):
        pname = self.expect("NAME", "parameter name")
        self.expect(":", "':'")
        ptype = self.parse_type()
        return (pname.text, ptype)

    def parse_type(self):
        tok = self.peek()
        if tok.kind == "NAME" and tok.text == "Int":
            self.advance()
            return INT
        got = repr(tok.text) if tok.text else "end of input"
        raise ParseError(f"expected type 'Int', got {got}", tok.line)

    def parse_expr(self):
        left = self.parse_term()
        while self.peek().kind == "+":
            op = self.advance()
            right = self.parse_term()
            left = Bin("+", left, right, op.line)
        return left

    def parse_term(self):
        left = self.parse_factor()
        while self.peek().kind == "*":
            op = self.advance()
            right = self.parse_factor()
            left = Bin("*", left, right, op.line)
        return left

    def parse_factor(self):
        tok = self.peek()
        if tok.kind == "INT":
            self.advance()
            return Num(int(tok.text), tok.line)
        if tok.kind == "NAME":
            self.advance()
            var = Var(tok.text, tok.line)
            if self.peek().kind == "(":
                self.advance()
                args = []
                if self.peek().kind != ")":
                    args.append(self.parse_expr())
                    while self.peek().kind == ",":
                        self.advance()
                        args.append(self.parse_expr())
                self.expect(")", "')'")
                return Call(var, args, tok.line)
            return var
        if tok.kind == "(":
            self.advance()
            expr = self.parse_expr()
            self.expect(")", "')'")
            return expr
        got = repr(tok.text) if tok.text else "end of input"
        raise ParseError(f"expected expression, got {got}", tok.line)


def parse(src: str) -> Module:
    """Parse source text into a Module, raising ParseError on failure."""
    return Parser(tokenize(src)).parse_module()
