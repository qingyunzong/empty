"""Lexer, parser, AST and types for the mini module language."""
from __future__ import annotations

from dataclasses import dataclass

# Types are plain tuples so they are JSON-serialisable.
INT = ("int",)
BOOL = ("bool",)
UNKNOWN = ("unknown",)


def FN(params, ret):
    return ("fn", tuple(params), ret)


def type_str(t):
    if t == INT:
        return "Int"
    if t == BOOL:
        return "Bool"
    if t == UNKNOWN:
        return "?"
    return "fn(" + ", ".join(type_str(p) for p in t[1]) + ") -> " + type_str(t[2])


def thaw(t):
    """Convert JSON lists back into (hashable, comparable) tuples."""
    if isinstance(t, list):
        return tuple(thaw(x) for x in t)
    return t


# --- AST -----------------------------------------------------------------

@dataclass
class Import:
    name: str
    line: int


@dataclass
class Let:
    name: str
    annotation: object
    expr: object
    line: int


@dataclass
class Fn:
    name: str
    params: list
    ret: object
    body: object
    line: int


@dataclass
class IntLit:
    value: int
    line: int


@dataclass
class BoolLit:
    value: bool
    line: int


@dataclass
class Var:
    name: str
    line: int


@dataclass
class Add:
    left: object
    right: object
    line: int


@dataclass
class Call:
    name: str
    args: list
    line: int


# --- Lexer ---------------------------------------------------------------

@dataclass
class Token:
    kind: str  # 'INT' | 'IDENT' | 'PUNCT' | 'ARROW' | 'EOF'
    value: str
    line: int


class ParseError(Exception):
    def __init__(self, line, message):
        super().__init__(message)
        self.line = line
        self.message = message


def tokenize(source):
    tokens = []
    line = 1
    i = 0
    n = len(source)
    while i < n:
        c = source[i]
        if c == "\n":
            line += 1
            i += 1
            continue
        if c in " \t\r":
            i += 1
            continue
        if c == "#":
            while i < n and source[i] != "\n":
                i += 1
            continue
        if c.isdigit():
            j = i
            while j < n and source[j].isdigit():
                j += 1
            tokens.append(Token("INT", source[i:j], line))
            i = j
            continue
        if c.isalpha() or c == "_":
            j = i
            while j < n and (source[j].isalnum() or source[j] == "_"):
                j += 1
            tokens.append(Token("IDENT", source[i:j], line))
            i = j
            continue
        if c == "-" and i + 1 < n and source[i + 1] == ">":
            tokens.append(Token("ARROW", "->", line))
            i += 2
            continue
        if c in ":=(),+":
            tokens.append(Token("PUNCT", c, line))
            i += 1
            continue
        raise ParseError(line, "unexpected character %r" % c)
    tokens.append(Token("EOF", "", line))
    return tokens


def describe(tok):
    if tok.kind == "EOF":
        return "end of file"
    return "%r" % tok.value


# --- Parser --------------------------------------------------------------

class Parser:
    def __init__(self, tokens):
        self.toks = tokens
        self.pos = 0
        self.imports = []

    def peek(self):
        return self.toks[self.pos]

    def advance(self):
        tok = self.toks[self.pos]
        self.pos += 1
        return tok

    def at_punct(self, p):
        tok = self.peek()
        return tok.kind == "PUNCT" and tok.value == p

    def expect_punct(self, p):
        tok = self.peek()
        if not (tok.kind == "PUNCT" and tok.value == p):
            raise ParseError(tok.line, "expected '%s' but found %s" % (p, describe(tok)))
        return self.advance()

    def expect_ident(self, what="identifier"):
        tok = self.peek()
        if tok.kind != "IDENT":
            raise ParseError(tok.line, "expected %s but found %s" % (what, describe(tok)))
        return self.advance()

    def parse(self):
        stmts = []
        while self.peek().kind != "EOF":
            stmts.append(self.parse_stmt())
        return stmts

    def parse_stmt(self):
        tok = self.peek()
        if tok.kind == "IDENT" and tok.value == "let":
            return self.parse_let()
        if tok.kind == "IDENT" and tok.value == "fn":
            return self.parse_fn()
        if tok.kind == "IDENT" and tok.value == "import":
            self.advance()
            nm = self.expect_ident("module name")
            self.imports.append(nm.value)
            return Import(nm.value, tok.line)
        raise ParseError(tok.line, "unexpected %s" % describe(tok))

    def parse_let(self):
        kw = self.advance()
        nm = self.expect_ident("variable name")
        ann = None
        if self.at_punct(":"):
            self.advance()
            ann = self.parse_type()
        self.expect_punct("=")
        expr = self.parse_expr()
        return Let(nm.value, ann, expr, kw.line)

    def parse_fn(self):
        kw = self.advance()
        nm = self.expect_ident("function name")
        self.expect_punct("(")
        params = []
        if not self.at_punct(")"):
            while True:
                p = self.expect_ident("parameter name")
                self.expect_punct(":")
                pt = self.parse_type()
                params.append((p.value, pt))
                if self.at_punct(","):
                    self.advance()
                    continue
                break
        self.expect_punct(")")
        tok = self.peek()
        if tok.kind != "ARROW":
            raise ParseError(tok.line, "expected '->' but found %s" % describe(tok))
        self.advance()
        ret = self.parse_type()
        self.expect_punct("=")
        body = self.parse_expr()
        return Fn(nm.value, params, ret, body, kw.line)

    def parse_type(self):
        tok = self.peek()
        if tok.kind == "IDENT" and tok.value in ("Int", "Bool"):
            self.advance()
            return INT if tok.value == "Int" else BOOL
        raise ParseError(tok.line, "expected type ('Int' or 'Bool') but found %s" % describe(tok))

    def parse_expr(self):
        left = self.parse_atom()
        while self.at_punct("+"):
            op = self.advance()
            right = self.parse_atom()
            left = Add(left, right, op.line)
        return left

    def parse_atom(self):
        tok = self.peek()
        if tok.kind == "INT":
            self.advance()
            return IntLit(int(tok.value), tok.line)
        if tok.kind == "IDENT":
            if tok.value == "true":
                self.advance()
                return BoolLit(True, tok.line)
            if tok.value == "false":
                self.advance()
                return BoolLit(False, tok.line)
            self.advance()
            if self.at_punct("("):
                self.advance()
                args = []
                if not self.at_punct(")"):
                    while True:
                        args.append(self.parse_expr())
                        if self.at_punct(","):
                            self.advance()
                            continue
                        break
                self.expect_punct(")")
                return Call(tok.value, args, tok.line)
            return Var(tok.value, tok.line)
        if self.at_punct("("):
            self.advance()
            e = self.parse_expr()
            self.expect_punct(")")
            return e
        raise ParseError(tok.line, "expected expression but found %s" % describe(tok))


def parse_module(source):
    """Return (statements, imports, error). On a parse error, statements is
    None and error is a ParseError; imports collected so far are kept."""
    try:
        tokens = tokenize(source)
    except ParseError as e:
        return None, [], e
    parser = Parser(tokens)
    try:
        stmts = parser.parse()
        return stmts, parser.imports, None
    except ParseError as e:
        return None, parser.imports, e
