"""AST nodes and recursive-descent parser for the upval language.

Grammar
-------
program     := stmt* EOF
stmt        := "let" IDENT "=" expr ";"
             | IDENT "=" expr ";"            (assignment)
             | "if" expr block "else" block  (expression statement)
             | expr ";"
expr        := comparison
comparison  := additive (("<"|"<="|"=="|"!="|">"|">=") additive)?
additive    := term (("+"|"-") term)*
term        := unary (("*"|"/"|"%") unary)*
unary       := "-" unary | postfix
postfix     := primary ("(" (expr ("," expr)*)? ")")*
primary     := INT | IDENT | "(" expr ")" | fnlit | ifexpr
fnlit       := "fn" "(" (IDENT ("," IDENT)*)? ")" block
ifexpr      := "if" expr block "else" block
block       := "{" stmt* "}"
"""

from .errors import ParseError
from .lexer import tokenize


class Node:
    span = None


class IntLit(Node):
    def __init__(self, value, span):
        self.value = value
        self.span = span


class Var(Node):
    def __init__(self, name, span):
        self.name = name
        self.span = span
        self.res = None  # ("local"|"upvalue", index), set by the resolver


class BinOp(Node):
    def __init__(self, op, left, right, span):
        self.op = op
        self.left = left
        self.right = right
        self.span = span


class IfExpr(Node):
    def __init__(self, cond, then, otherwise, span):
        self.cond = cond
        self.then = then
        self.otherwise = otherwise
        self.span = span


class FnLit(Node):
    def __init__(self, params, body, span):
        self.params = params  # list of (name, span)
        self.body = body      # Block
        self.span = span
        self.info = None      # FnInfo, set by the resolver


class Call(Node):
    def __init__(self, callee, args, span):
        self.callee = callee
        self.args = args
        self.span = span


class Block(Node):
    def __init__(self, stmts, span):
        self.stmts = stmts
        self.span = span


class Let(Node):
    def __init__(self, name, name_span, value, span):
        self.name = name
        self.name_span = name_span
        self.value = value
        self.span = span
        self.slot = None  # local slot index, set by the resolver


class Assign(Node):
    def __init__(self, name, name_span, value, span):
        self.name = name
        self.name_span = name_span
        self.value = value
        self.span = span
        self.res = None    # ("local"|"upvalue", index)
        self.owner = None  # FnInfo that owns the target local


class ExprStmt(Node):
    def __init__(self, expr, span):
        self.expr = expr
        self.span = span


def _join(start_span, end_span):
    return (start_span[0], start_span[1], end_span[2], end_span[3])


class Parser:
    def __init__(self, src):
        self.tokens = tokenize(src)
        self.pos = 0

    def peek(self):
        return self.tokens[self.pos]

    def next(self):
        tok = self.tokens[self.pos]
        if tok.kind != "EOF":
            self.pos += 1
        return tok

    def at(self, text):
        return self.peek().text == text

    def expect(self, text):
        tok = self.next()
        if tok.text != text:
            raise ParseError(f"expected {text!r}, got {tok.text!r}", span=tok.span)
        return tok

    def expect_ident(self):
        tok = self.next()
        if tok.kind != "IDENT":
            raise ParseError(f"expected identifier, got {tok.text!r}", span=tok.span)
        return tok

    # -- statements -----------------------------------------------------

    def parse_program(self):
        start = self.peek().span
        stmts = []
        while self.peek().kind != "EOF":
            stmts.append(self.parse_stmt())
        end = self.tokens[self.pos].span
        return Block(stmts, _join(start, end))

    def parse_stmt(self):
        tok = self.peek()
        if tok.text == "let":
            self.next()
            name = self.expect_ident()
            self.expect("=")
            value = self.parse_expr()
            semi = self.expect(";")
            return Let(name.text, name.span, value, _join(tok.span, semi.span))
        if tok.text == "if":
            expr = self.parse_expr()  # if-expression used as a statement
            return ExprStmt(expr, expr.span)
        expr = self.parse_expr()
        if isinstance(expr, Var) and self.at("="):
            self.next()
            value = self.parse_expr()
            semi = self.expect(";")
            return Assign(expr.name, expr.span, value, _join(expr.span, semi.span))
        if self.at(";"):
            semi = self.next()
            return ExprStmt(expr, _join(expr.span, semi.span))
        if self.at("}"):
            # the semicolon may be omitted for the last statement of a block
            return ExprStmt(expr, expr.span)
        tok = self.peek()
        raise ParseError(f"expected ';', got {tok.text!r}", span=tok.span)

    def parse_block(self):
        open_tok = self.expect("{")
        stmts = []
        while not self.at("}"):
            if self.peek().kind == "EOF":
                raise ParseError("unterminated block", span=self.peek().span)
            stmts.append(self.parse_stmt())
        close = self.expect("}")
        return Block(stmts, _join(open_tok.span, close.span))

    # -- expressions ----------------------------------------------------

    def parse_expr(self):
        return self.parse_comparison()

    def parse_comparison(self):
        left = self.parse_additive()
        if self.peek().text in ("<", "<=", "==", "!=", ">", ">="):
            op = self.next()
            right = self.parse_additive()
            return BinOp(op.text, left, right, _join(left.span, right.span))
        return left

    def parse_additive(self):
        left = self.parse_term()
        while self.peek().text in ("+", "-"):
            op = self.next()
            right = self.parse_term()
            left = BinOp(op.text, left, right, _join(left.span, right.span))
        return left

    def parse_term(self):
        left = self.parse_unary()
        while self.peek().text in ("*", "/", "%"):
            op = self.next()
            right = self.parse_unary()
            left = BinOp(op.text, left, right, _join(left.span, right.span))
        return left

    def parse_unary(self):
        if self.at("-"):
            tok = self.next()
            operand = self.parse_unary()
            zero = IntLit(0, tok.span)
            return BinOp("-", zero, operand, _join(tok.span, operand.span))
        return self.parse_postfix()

    def parse_postfix(self):
        expr = self.parse_primary()
        while self.at("("):
            self.next()
            args = []
            if not self.at(")"):
                while True:
                    args.append(self.parse_expr())
                    if self.at(","):
                        self.next()
                        continue
                    break
            close = self.expect(")")
            expr = Call(expr, args, _join(expr.span, close.span))
        return expr

    def parse_primary(self):
        tok = self.next()
        if tok.kind == "INT":
            return IntLit(int(tok.text), tok.span)
        if tok.kind == "IDENT":
            return Var(tok.text, tok.span)
        if tok.text == "(":
            expr = self.parse_expr()
            self.expect(")")
            return expr
        if tok.text == "fn":
            self.expect("(")
            params = []
            if not self.at(")"):
                while True:
                    name = self.expect_ident()
                    params.append((name.text, name.span))
                    if self.at(","):
                        self.next()
                        continue
                    break
            self.expect(")")
            body = self.parse_block()
            return FnLit(params, body, _join(tok.span, body.span))
        if tok.text == "if":
            cond = self.parse_expr()
            then = self.parse_block()
            self.expect("else")
            otherwise = self.parse_block()
            return IfExpr(cond, then, otherwise, _join(tok.span, otherwise.span))
        raise ParseError(f"unexpected token {tok.text!r}", span=tok.span)


def parse(src):
    return Parser(src).parse_program()
