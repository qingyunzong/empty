"""Recursive-descent parser producing the upval AST.

Grammar:
    program  := stmt* EOF
    stmt     := "let" IDENT "=" expr ";"
              | IDENT "=" expr ";"
              | "return" expr ";"
              | "if" expr block ("else" block)?
              | expr ";"
    block    := "{" stmt* "}"
    expr     := cmp
    cmp      := add (("<"|"<="|">"|">="|"=="|"!=") add)?
    add      := mul (("+"|"-") mul)*
    mul      := unary (("*"|"/"|"%") unary)*
    unary    := "-" unary | postfix
    postfix  := primary ("(" (expr ("," expr)*)? ")")*
    primary  := INT | IDENT | "(" expr ")" | fnlit
    fnlit    := "fn" "(" (IDENT ("," IDENT)*)? ")" block
"""

from .errors import ParseError
from .lexer import tokenize


class Node:
    __slots__ = ("span",)

    def __init__(self, span):
        self.span = span


class Program(Node):
    __slots__ = ("body",)

    def __init__(self, body, span):
        super().__init__(span)
        self.body = body


class Let(Node):
    __slots__ = ("name", "name_span", "value", "binding")

    def __init__(self, name, name_span, value, span):
        super().__init__(span)
        self.name = name
        self.name_span = name_span
        self.value = value
        self.binding = None


class Assign(Node):
    __slots__ = ("name", "name_span", "value", "binding", "depth")

    def __init__(self, name, name_span, value, span):
        super().__init__(span)
        self.name = name
        self.name_span = name_span
        self.value = value
        self.binding = None
        self.depth = 0


class Return(Node):
    __slots__ = ("value",)

    def __init__(self, value, span):
        super().__init__(span)
        self.value = value


class If(Node):
    __slots__ = ("cond", "then", "otherwise")

    def __init__(self, cond, then, otherwise, span):
        super().__init__(span)
        self.cond = cond
        self.then = then
        self.otherwise = otherwise


class ExprStmt(Node):
    __slots__ = ("expr",)

    def __init__(self, expr, span):
        super().__init__(span)
        self.expr = expr


class IntLit(Node):
    __slots__ = ("value",)

    def __init__(self, value, span):
        super().__init__(span)
        self.value = value


class Var(Node):
    __slots__ = ("name", "binding", "depth")

    def __init__(self, name, span):
        super().__init__(span)
        self.name = name
        self.binding = None
        self.depth = 0


class FnLit(Node):
    __slots__ = ("params", "body", "fn_info", "param_bindings")

    def __init__(self, params, body, span):
        super().__init__(span)
        self.params = params  # list of (name, name_span)
        self.body = body
        self.fn_info = None
        self.param_bindings = []


class Call(Node):
    __slots__ = ("func", "args")

    def __init__(self, func, args, span):
        super().__init__(span)
        self.func = func
        self.args = args


class BinOp(Node):
    __slots__ = ("op", "left", "right")

    def __init__(self, op, left, right, span):
        super().__init__(span)
        self.op = op
        self.left = left
        self.right = right


class UnaryOp(Node):
    __slots__ = ("op", "operand")

    def __init__(self, op, operand, span):
        super().__init__(span)
        self.op = op
        self.operand = operand


CMP_OPS = {"LT": "<", "LE": "<=", "GT": ">", "GE": ">=", "EQ": "==", "NE": "!="}


class Parser:
    def __init__(self, tokens):
        self.tokens = tokens
        self.pos = 0

    def peek(self, k=0):
        idx = min(self.pos + k, len(self.tokens) - 1)
        return self.tokens[idx]

    def at(self, kind):
        return self.peek().kind == kind

    def advance(self):
        tok = self.tokens[self.pos]
        if self.pos < len(self.tokens) - 1:
            self.pos += 1
        return tok

    def expect(self, kind, what=None):
        if not self.at(kind):
            tok = self.peek()
            raise ParseError(
                span=(tok.start, tok.end),
                message=f"expected {what or kind}, got {tok.kind} ({tok.text!r})",
            )
        return self.advance()

    def parse_program(self):
        stmts = []
        while not self.at("EOF"):
            stmts.append(self.parse_stmt())
        return Program(stmts, (0, self.peek().end))

    def parse_stmt(self):
        tok = self.peek()
        if tok.kind == "LET":
            self.advance()
            name = self.expect("IDENT", "variable name")
            self.expect("ASSIGN", "'='")
            value = self.parse_expr()
            semi = self.expect("SEMI", "';'")
            return Let(name.text, (name.start, name.end), value, (tok.start, semi.end))
        if tok.kind == "RETURN":
            self.advance()
            value = self.parse_expr()
            semi = self.expect("SEMI", "';'")
            return Return(value, (tok.start, semi.end))
        if tok.kind == "IF":
            return self.parse_if()
        if tok.kind == "IDENT" and self.peek(1).kind == "ASSIGN":
            name = self.advance()
            self.advance()
            value = self.parse_expr()
            semi = self.expect("SEMI", "';'")
            return Assign(name.text, (name.start, name.end), value, (tok.start, semi.end))
        expr = self.parse_expr()
        semi = self.expect("SEMI", "';'")
        return ExprStmt(expr, (expr.span[0], semi.end))

    def parse_if(self):
        start = self.expect("IF")
        cond = self.parse_expr()
        then = self.parse_block()
        otherwise = []
        end_span = then[-1].span[1] if then else cond.span[1]
        if self.at("ELSE"):
            self.advance()
            otherwise = self.parse_block()
            if otherwise:
                end_span = otherwise[-1].span[1]
        return If(cond, then, otherwise, (start.start, end_span))

    def parse_block(self):
        self.expect("LBRACE", "'{'")
        stmts = []
        while not self.at("RBRACE"):
            if self.at("EOF"):
                tok = self.peek()
                raise ParseError(span=(tok.start, tok.end), message="unterminated block")
            stmts.append(self.parse_stmt())
        self.expect("RBRACE")
        return stmts

    def parse_expr(self):
        return self.parse_cmp()

    def parse_cmp(self):
        left = self.parse_add()
        if self.peek().kind in CMP_OPS:
            op = CMP_OPS[self.advance().kind]
            right = self.parse_add()
            return BinOp(op, left, right, (left.span[0], right.span[1]))
        return left

    def parse_add(self):
        left = self.parse_mul()
        while self.peek().kind in ("PLUS", "MINUS"):
            op = "+" if self.advance().kind == "PLUS" else "-"
            right = self.parse_mul()
            left = BinOp(op, left, right, (left.span[0], right.span[1]))
        return left

    def parse_mul(self):
        left = self.parse_unary()
        while self.peek().kind in ("STAR", "SLASH", "PERCENT"):
            kind = self.advance().kind
            op = {"STAR": "*", "SLASH": "/", "PERCENT": "%"}[kind]
            right = self.parse_unary()
            left = BinOp(op, left, right, (left.span[0], right.span[1]))
        return left

    def parse_unary(self):
        if self.at("MINUS"):
            tok = self.advance()
            operand = self.parse_unary()
            return UnaryOp("-", operand, (tok.start, operand.span[1]))
        return self.parse_postfix()

    def parse_postfix(self):
        expr = self.parse_primary()
        while self.at("LPAREN"):
            self.advance()
            args = []
            if not self.at("RPAREN"):
                args.append(self.parse_expr())
                while self.at("COMMA"):
                    self.advance()
                    args.append(self.parse_expr())
            rparen = self.expect("RPAREN", "')'")
            expr = Call(expr, args, (expr.span[0], rparen.end))
        return expr

    def parse_primary(self):
        tok = self.peek()
        if tok.kind == "INT":
            self.advance()
            return IntLit(int(tok.text), (tok.start, tok.end))
        if tok.kind == "IDENT":
            self.advance()
            return Var(tok.text, (tok.start, tok.end))
        if tok.kind == "LPAREN":
            self.advance()
            expr = self.parse_expr()
            self.expect("RPAREN", "')'")
            return expr
        if tok.kind == "FN":
            return self.parse_fnlit()
        raise ParseError(
            span=(tok.start, tok.end),
            message=f"unexpected token {tok.kind} ({tok.text!r})",
        )

    def parse_fnlit(self):
        start = self.expect("FN")
        self.expect("LPAREN", "'('")
        params = []
        if not self.at("RPAREN"):
            name = self.expect("IDENT", "parameter name")
            params.append((name.text, (name.start, name.end)))
            while self.at("COMMA"):
                self.advance()
                name = self.expect("IDENT", "parameter name")
                params.append((name.text, (name.start, name.end)))
        self.expect("RPAREN", "')'")
        body = self.parse_block()
        end = body[-1].span[1] if body else start.end
        return FnLit(params, body, (start.start, end))


def parse(src):
    return Parser(tokenize(src)).parse_program()
