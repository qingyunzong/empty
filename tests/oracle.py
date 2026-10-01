"""Independent oracle: a plain recursive-descent parser.

Written in a deliberately different style from prattx's Pratt parser so the
enumeration test compares two independent implementations of the same
precedence/associativity rules. Produces normalized tuple trees:

    ("int", value)
    ("ident", name)
    ("unary", op, operand)
    ("binary", op, left, right)
    ("ternary", cond, then, otherwise)
    ("call", func, (arg, ...))
    ("index", target, index)
"""

from prattx.lexer import lex


def normalize(node):
    """Convert a prattx AST dict into the oracle's tuple tree shape."""
    kind = node["type"]
    if kind == "int":
        return ("int", node["value"])
    if kind == "ident":
        return ("ident", node["name"])
    if kind == "unary":
        return ("unary", node["op"], normalize(node["operand"]))
    if kind == "binary":
        return ("binary", node["op"], normalize(node["left"]), normalize(node["right"]))
    if kind == "ternary":
        return (
            "ternary",
            normalize(node["cond"]),
            normalize(node["then"]),
            normalize(node["else"]),
        )
    if kind == "call":
        return ("call", normalize(node["func"]), tuple(normalize(a) for a in node["args"]))
    if kind == "index":
        return ("index", normalize(node["target"]), normalize(node["index"]))
    raise AssertionError("unknown node type %r" % kind)


class _Oracle:
    def __init__(self, tokens):
        self.toks = tokens
        self.pos = 0

    def peek(self):
        return self.toks[self.pos]

    def at(self, text):
        tok = self.peek()
        return tok.kind == "op" and tok.text == text

    def eat(self, text=None):
        tok = self.toks[self.pos]
        if text is not None:
            assert tok.kind == "op" and tok.text == text, (tok, text)
        self.pos += 1
        return tok


def parse_oracle(source):
    oracle = _Oracle(lex(source))
    node = _assign(oracle)
    assert oracle.peek().kind == "eof", "oracle did not consume all tokens"
    return node


def _assign(o):
    left = _ternary(o)
    if o.at("="):
        o.eat("=")
        return ("binary", "=", left, _assign(o))
    return left


def _ternary(o):
    cond = _or(o)
    if o.at("?"):
        o.eat("?")
        then = _assign(o)
        o.eat(":")
        return ("ternary", cond, then, _ternary(o))
    return cond


def _left_assoc(o, sub, ops):
    left = sub(o)
    while True:
        tok = o.peek()
        if tok.kind == "op" and tok.text in ops:
            o.eat()
            left = ("binary", tok.text, left, sub(o))
        else:
            return left


def _or(o):
    return _left_assoc(o, _and, {"||"})


def _and(o):
    return _left_assoc(o, _cmp, {"&&"})


def _cmp(o):
    return _left_assoc(o, _add, {"==", "!=", "<", "<=", ">", ">="})


def _add(o):
    return _left_assoc(o, _mul, {"+", "-"})


def _mul(o):
    return _left_assoc(o, _unary, {"*", "/", "%"})


def _unary(o):
    tok = o.peek()
    if tok.kind == "op" and tok.text in {"+", "-", "!"}:
        o.eat()
        return ("unary", tok.text, _unary(o))
    return _power(o)


def _power(o):
    base = _postfix(o)
    if o.at("**"):
        o.eat("**")
        return ("binary", "**", base, _unary(o))
    return base


def _postfix(o):
    node = _primary(o)
    while True:
        if o.at("("):
            o.eat("(")
            args = []
            if not o.at(")"):
                args.append(_assign(o))
                while o.at(","):
                    o.eat(",")
                    args.append(_assign(o))
            o.eat(")")
            node = ("call", node, tuple(args))
        elif o.at("["):
            o.eat("[")
            index = _assign(o)
            o.eat("]")
            node = ("index", node, index)
        else:
            return node


def _primary(o):
    tok = o.peek()
    if tok.kind == "int":
        o.eat()
        return ("int", int(tok.text))
    if tok.kind == "ident":
        o.eat()
        return ("ident", tok.text)
    if o.at("("):
        o.eat("(")
        node = _assign(o)
        o.eat(")")
        return node
    raise AssertionError("oracle cannot parse %r" % (tok,))
