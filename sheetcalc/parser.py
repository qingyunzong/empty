"""Tokenizer, recursive-descent parser and AST evaluator for cell expressions.

Grammar:
    expr   := term (('+' | '-') term)*
    term   := factor (('*' | '/') factor)*
    factor := INT | CELL | '(' expr ')' | '-' factor | '+' factor

AST nodes are tuples, comparable by structural equality:
    ('num', int) | ('ref', name) |
    ('add'|'sub'|'mul'|'div', left, right) | ('neg'|'pos', operand)
"""

E_DIV0 = "E_DIV0"


class ParseError(Exception):
    """Raised for any lexical or syntactic error in an expression."""


def tokenize(src):
    tokens = []
    i = 0
    n = len(src)
    while i < n:
        c = src[i]
        if c.isspace():
            i += 1
        elif c.isdigit():
            j = i
            while j < n and src[j].isdigit():
                j += 1
            tokens.append(("num", int(src[i:j])))
            i = j
        elif c.isalpha():
            j = i
            while j < n and src[j].isalpha():
                j += 1
            k = j
            while k < n and src[k].isdigit():
                k += 1
            if k == j:
                raise ParseError("invalid cell reference %r" % src[i:j])
            tokens.append(("ref", src[i:k]))
            i = k
        elif c in "+-*/()":
            tokens.append((c, c))
            i += 1
        else:
            raise ParseError("unexpected character %r" % c)
    tokens.append(("eof", None))
    return tokens


class _Parser:
    def __init__(self, tokens):
        self.tokens = tokens
        self.pos = 0

    def peek(self):
        return self.tokens[self.pos][0]

    def next(self):
        tok = self.tokens[self.pos]
        self.pos += 1
        return tok

    def expect(self, kind):
        if self.peek() != kind:
            raise ParseError("expected %r, got %r" % (kind, self.tokens[self.pos]))
        return self.next()

    def parse_expr(self):
        node = self.parse_term()
        while self.peek() in ("+", "-"):
            op = self.next()[0]
            rhs = self.parse_term()
            node = ("add" if op == "+" else "sub", node, rhs)
        return node

    def parse_term(self):
        node = self.parse_factor()
        while self.peek() in ("*", "/"):
            op = self.next()[0]
            rhs = self.parse_factor()
            node = ("mul" if op == "*" else "div", node, rhs)
        return node

    def parse_factor(self):
        kind = self.peek()
        if kind == "num":
            return ("num", self.next()[1])
        if kind == "ref":
            return ("ref", self.next()[1])
        if kind == "(":
            self.next()
            node = self.parse_expr()
            self.expect(")")
            return node
        if kind == "-":
            self.next()
            return ("neg", self.parse_factor())
        if kind == "+":
            self.next()
            return ("pos", self.parse_factor())
        raise ParseError("unexpected token %r" % (self.tokens[self.pos],))


def parse(src):
    """Parse an expression string into an AST. Raises ParseError."""
    parser = _Parser(tokenize(src))
    node = parser.parse_expr()
    if parser.peek() != "eof":
        raise ParseError("trailing input after expression")
    return node


def refs_of(node):
    """Return the set of cell names referenced by an AST."""
    out = set()

    def walk(n):
        if n[0] == "ref":
            out.add(n[1])
        for child in n[1:]:
            if isinstance(child, tuple):
                walk(child)

    walk(node)
    return out


def _trunc_div(a, b):
    q = abs(a) // abs(b)
    return q if (a < 0) == (b < 0) else -q


def eval_ast(node, lookup):
    """Evaluate an AST. lookup(name) -> int | E_DIV0 for cell references."""
    op = node[0]
    if op == "num":
        return node[1]
    if op == "ref":
        return lookup(node[1])
    if op == "neg":
        v = eval_ast(node[1], lookup)
        return E_DIV0 if v == E_DIV0 else -v
    if op == "pos":
        return eval_ast(node[1], lookup)
    left = eval_ast(node[1], lookup)
    right = eval_ast(node[2], lookup)
    if left == E_DIV0 or right == E_DIV0:
        return E_DIV0
    if op == "add":
        return left + right
    if op == "sub":
        return left - right
    if op == "mul":
        return left * right
    if op == "div":
        if right == 0:
            return E_DIV0
        return _trunc_div(left, right)
    raise AssertionError("unknown AST node %r" % (node,))
