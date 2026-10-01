"""Expression tokenizer and recursive-descent parser.

Grammar:
    expr   := term (('+' | '-') term)*
    term   := factor (('*' | '/') factor)*
    factor := INT | CELL | '(' expr ')' | ('+' | '-') factor

AST nodes are tuples:
    ('num', int)
    ('ref', cell_name)
    ('neg', child)
    ('add' | 'sub' | 'mul' | 'div', left, right)
"""

import re

CELL_RE = re.compile(r"^[A-Za-z]+[0-9]+$")


class ParseError(Exception):
    """Raised for any lexical or syntactic error in an expression."""


def tokenize(text):
    tokens = []
    i = 0
    n = len(text)
    while i < n:
        ch = text[i]
        if ch.isspace():
            i += 1
        elif ch.isdigit():
            j = i
            while j < n and text[j].isdigit():
                j += 1
            tokens.append(("num", int(text[i:j])))
            i = j
        elif ch.isalpha() or ch == "_":
            j = i
            while j < n and (text[j].isalnum() or text[j] == "_"):
                j += 1
            name = text[i:j].upper()
            if not CELL_RE.match(name):
                raise ParseError("invalid cell reference: %r" % (text[i:j],))
            tokens.append(("ref", name))
            i = j
        elif ch in "+-*/()":
            tokens.append((ch, ch))
            i += 1
        else:
            raise ParseError("unexpected character: %r" % (ch,))
    tokens.append(("eof", None))
    return tokens


class _Parser:
    def __init__(self, tokens):
        self.tokens = tokens
        self.pos = 0

    def _peek(self):
        return self.tokens[self.pos][0]

    def _next(self):
        tok = self.tokens[self.pos]
        self.pos += 1
        return tok

    def parse(self):
        node = self._expr()
        if self._peek() != "eof":
            raise ParseError("unexpected trailing token: %r" % (self.tokens[self.pos][1],))
        return node

    def _expr(self):
        node = self._term()
        while self._peek() in ("+", "-"):
            op = self._next()[0]
            rhs = self._term()
            node = ("add" if op == "+" else "sub", node, rhs)
        return node

    def _term(self):
        node = self._factor()
        while self._peek() in ("*", "/"):
            op = self._next()[0]
            rhs = self._factor()
            node = ("mul" if op == "*" else "div", node, rhs)
        return node

    def _factor(self):
        kind, value = self._next()
        if kind == "num":
            return ("num", value)
        if kind == "ref":
            return ("ref", value)
        if kind == "-":
            return ("neg", self._factor())
        if kind == "+":
            return self._factor()
        if kind == "(":
            node = self._expr()
            if self._peek() != ")":
                raise ParseError("expected ')'")
            self._next()
            return node
        if kind == "eof":
            raise ParseError("unexpected end of expression")
        raise ParseError("unexpected token: %r" % (value,))


def parse(text):
    """Parse an expression string into an AST. Raises ParseError."""
    return _Parser(tokenize(text)).parse()
